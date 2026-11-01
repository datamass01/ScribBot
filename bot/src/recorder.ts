import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileAtomic } from "./fsutil.js";
import { TolerantOpusDecoder } from "./opus.js";
import { sessionPaths } from "./paths.js";
import { appendLineSync } from "./timeline.js";
import type { Participant, Segment, Timeline } from "./types.js";
import { WavFileWriter } from "./wav.js";

// Whistle's native rate; Opus decodes straight to it, so the worker never resamples.
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;
/** Silence that closes an utterance. Shorter = more, smaller segments. */
const SILENCE_MS = 800;
/** Bursts shorter than this are almost always clicks, coughs or keyboard noise. */
const MIN_SEGMENT_MS = 250;
/** How often timeline.json is re-snapshotted while clips arrive; each clip is journaled at once (02 S10). */
const SNAPSHOT_INTERVAL_MS = 30_000;
/** Waits between rejoin attempts after the voice connection is lost; the last one repeats (02 S4). */
const REJOIN_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];
/** After this many failed rejoins the recording is reported as lost (it keeps trying). */
const REJOIN_ATTEMPTS_BEFORE_LOST = 5;

export type ParticipantResolver = (userId: string) => Promise<Participant | null>;
/** Called when a clip is finalized on disk. `file` is relative to the session folder. */
export type SegmentListener = (file: string, characterNames: string[]) => void;

export type ConnectionState = "connected" | "reconnecting" | "lost";
export type ConnectionEvent =
  | { type: "reconnecting" }
  | { type: "lost"; attempts: number }
  | { type: "restored"; gapMs: number };

export interface RecorderOptions {
  onSegment?: SegmentListener;
  log?: (msg: string) => void;
  /** Continue an interrupted recording of the same session (02 S3): same clock, same clips. */
  resume?: { startedAtMs: number; participants: Participant[]; segments: Segment[] };
  /** Voice connection lost / restored, for a message in the text channel. */
  onConnection?: (e: ConnectionEvent) => void;
  /** For tests: how the voice connection is opened. */
  join?: (channel: VoiceBasedChannel) => VoiceConnection;
}

const defaultJoin = (channel: VoiceBasedChannel) =>
  joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // must be undeafened to receive audio
    selfMute: true,
  });

/** Records one voice channel: one WAV file per speech burst per speaker. */
export class SessionRecorder {
  readonly startedAtMs: number;
  private connection: VoiceConnection | null = null;
  private participants = new Map<string, Participant>();
  private ignored = new Set<string>();
  private segments: Segment[] = [];
  private active = new Set<Promise<void>>();
  private stopping = false;
  private paths: ReturnType<typeof sessionPaths>;
  private onSegment: SegmentListener;
  private log: (msg: string) => void;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private state: ConnectionState = "connected";
  private rejoining = false;

  constructor(
    readonly sessionId: string,
    readonly channel: VoiceBasedChannel,
    private resolveParticipant: ParticipantResolver,
    private opts: RecorderOptions = {},
  ) {
    this.paths = sessionPaths(sessionId);
    this.onSegment = opts.onSegment ?? (() => {});
    this.log = opts.log ?? console.log;
    this.startedAtMs = opts.resume?.startedAtMs ?? Date.now();
    for (const p of opts.resume?.participants ?? []) this.participants.set(p.discordId, p);
    this.segments = [...(opts.resume?.segments ?? [])];
  }

  async start() {
    fs.mkdirSync(this.paths.audio, { recursive: true });
    this.snapshot(null);
    await this.connect();
    this.snapshotTimer = setInterval(() => {
      if (this.dirty) this.snapshot(null);
    }, SNAPSHOT_INTERVAL_MS);
    this.snapshotTimer.unref();
  }

  /** Join the channel and wire up listeners. Throws if it isn't ready within 20 s. */
  private async connect() {
    const connection = (this.opts.join ?? defaultJoin)(this.channel);
    this.connection = connection;
    // An `error` with no listener is thrown and would end the process (02 S2).
    connection.on("error", (err) => this.log(`[recorder] ${this.sessionId}: voice connection error: ${err?.message ?? err}`));
    if (process.env.SCRIBBOT_DEBUG_VOICE) {
      connection.on("stateChange", (from, to) => this.log(`[recorder] voice ${from.status} -> ${to.status}`));
    }
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      if (this.connection === connection) this.connection = null;
      connection.destroy();
      throw err;
    }

    connection.receiver.speaking.on("start", (userId) => {
      if (this.stopping || this.connection !== connection) return;
      void this.capture(userId).catch((err) => this.log(`[recorder] capture ${userId} failed: ${err}`));
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Try to ride out channel moves / brief network drops before giving up on this connection.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.dropConnection(connection);
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => this.dropConnection(connection));
  }

  /** The connection is gone for good: close its clips and start rejoining (02 S4). */
  private dropConnection(connection: VoiceConnection) {
    if (this.stopping || this.connection !== connection) return;
    this.connection = null;
    for (const stream of connection.receiver.subscriptions.values()) stream.push(null);
    try {
      connection.destroy();
    } catch {
      // already destroyed
    }
    this.log(`[recorder] ${this.sessionId}: lost voice connection; rejoining`);
    void this.rejoin();
  }

  private async rejoin() {
    if (this.rejoining) return;
    this.rejoining = true;
    this.state = "reconnecting";
    this.opts.onConnection?.({ type: "reconnecting" });
    const lostAt = Date.now();
    try {
      for (let attempt = 1; !this.stopping; attempt++) {
        await sleep(REJOIN_DELAYS_MS[Math.min(attempt - 1, REJOIN_DELAYS_MS.length - 1)]!);
        if (this.stopping) return;
        try {
          await this.connect();
          if (this.stopping) {
            this.connection?.destroy();
            this.connection = null;
            return;
          }
          this.state = "connected";
          const gapMs = Date.now() - lostAt;
          this.log(`[recorder] ${this.sessionId}: rejoined the voice channel after ${Math.round(gapMs / 1000)} s`);
          this.opts.onConnection?.({ type: "restored", gapMs });
          return;
        } catch (err) {
          this.log(`[recorder] ${this.sessionId}: rejoin attempt ${attempt} failed: ${(err as Error)?.message ?? err}`);
          if (attempt === REJOIN_ATTEMPTS_BEFORE_LOST) {
            this.state = "lost";
            this.opts.onConnection?.({ type: "lost", attempts: attempt });
          }
        }
      }
    } finally {
      this.rejoining = false;
    }
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get speakerCount() {
    return this.participants.size;
  }

  get segmentCount() {
    return this.segments.length;
  }

  get speakers() {
    return [...this.participants.values()];
  }

  /** Users currently mid-utterance. */
  get speakingNow() {
    return [...(this.connection?.receiver.subscriptions.keys() ?? [])];
  }

  private async capture(userId: string) {
    const receiver = this.connection?.receiver;
    if (!receiver || receiver.subscriptions.has(userId) || this.ignored.has(userId)) return;

    if (!this.participants.has(userId)) {
      const p = await this.resolveParticipant(userId);
      if (!p) {
        this.ignored.add(userId); // bots
        return;
      }
      this.participants.set(userId, p);
      this.snapshot(null);
      if (receiver.subscriptions.has(userId)) return; // raced with another start event
    }

    const startMs = Date.now() - this.startedAtMs;
    const userDir = path.join(this.paths.audio, userId);
    fs.mkdirSync(userDir, { recursive: true });
    const file = path.join(userDir, `${String(startMs).padStart(9, "0")}.wav`);

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new TolerantOpusDecoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 320 }); // 20 ms frames
    const wav = new WavFileWriter(file, SAMPLE_RATE, CHANNELS);

    const job: Promise<void> = pipeline(opus, decoder, wav)
      .catch((err) => {
        // Undecodable packets are skipped by the decoder; this is a stream failure. Keep whatever was written.
        if (!this.stopping) this.log(`[recorder] stream error for ${userId}: ${err?.message ?? err}`);
      })
      .then(() => {
        if (decoder.dropped > 0) {
          this.log(`[recorder] skipped ${decoder.dropped} undecodable packet(s) from ${userId} (${decoder.decoded} decoded)`);
        }
        this.finishClip(userId, startMs, file, wav.dataBytes / BYTES_PER_MS);
      })
      .catch((err) => this.log(`[recorder] finishing a clip from ${userId} failed: ${err?.stack ?? err}`))
      .finally(() => this.active.delete(job));
    this.active.add(job);
  }

  /**
   * Record a finished clip. Never throws: a failed write must not end the process (02 S1).
   * The journal append comes before `onSegment`, so the timeline lists a clip before its audio
   * can be transcribed and deleted.
   */
  private finishClip(userId: string, startMs: number, file: string, durationMs: number) {
    try {
      if (durationMs < MIN_SEGMENT_MS) {
        fs.rmSync(file, { force: true });
        return;
      }
      const segment: Segment = {
        discordId: userId,
        startMs,
        endMs: Math.round(startMs + durationMs),
        file: path.relative(this.paths.dir, file).split(path.sep).join("/"),
      };
      this.segments.push(segment);
      this.dirty = true;
      try {
        appendLineSync(this.paths.segmentsJournal, JSON.stringify(segment));
      } catch (err) {
        this.log(`[recorder] could not append to the segment journal (${(err as Error).message}); writing timeline.json instead`);
        if (!this.snapshot(null)) return; // listed nowhere on disk: keep the clip, don't hand it on for deletion
      }
      const names = [...this.participants.values()].flatMap((p) => (p.character ? [p.character] : []));
      this.onSegment(segment.file, names);
    } catch (err) {
      this.log(`[recorder] clip ${file} could not be recorded: ${(err as Error)?.stack ?? err}`);
    }
  }

  /** Leave the channel, flush every open segment, and finalize timeline.json. */
  async stop(): Promise<Timeline> {
    this.stopping = true;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    const receiver = this.connection?.receiver;
    if (receiver) {
      for (const stream of receiver.subscriptions.values()) stream.push(null);
    }
    await Promise.allSettled([...this.active]);
    try {
      this.connection?.destroy();
    } catch {
      // already destroyed
    }
    this.connection = null;
    const timeline = this.build(new Date().toISOString());
    this.snapshot(timeline.endedAt);
    return timeline;
  }

  private build(endedAt: string | null): Timeline {
    return {
      sessionId: this.sessionId,
      guildId: this.channel.guild.id,
      channelId: this.channel.id,
      startedAt: new Date(this.startedAtMs).toISOString(),
      endedAt,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      participants: [...this.participants.values()],
      segments: [...this.segments].sort((a, b) => a.startMs - b.startMs),
    };
  }

  /** Write the full timeline.json. Returns false (logged) instead of throwing on failure. */
  private snapshot(endedAt: string | null): boolean {
    try {
      writeFileAtomic(this.paths.timeline, JSON.stringify(this.build(endedAt), null, 2));
      this.dirty = false;
      return true;
    } catch (err) {
      this.log(`[recorder] ${this.sessionId}: writing timeline.json failed: ${(err as Error)?.message ?? err}`);
      return false;
    }
  }
}
