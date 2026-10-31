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
import prism from "prism-media";
import { sessionPaths } from "./paths.js";
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

export type ParticipantResolver = (userId: string) => Promise<Participant | null>;
/** Called when a clip is finalized on disk. `file` is relative to the session folder. */
export type SegmentListener = (file: string, characterNames: string[]) => void;

/** Records one voice channel: one WAV file per speech burst per speaker. */
export class SessionRecorder {
  readonly startedAtMs = Date.now();
  private connection: VoiceConnection | null = null;
  private participants = new Map<string, Participant>();
  private ignored = new Set<string>();
  private segments: Segment[] = [];
  private active = new Set<Promise<void>>();
  private stopping = false;
  private paths: ReturnType<typeof sessionPaths>;

  constructor(
    readonly sessionId: string,
    readonly channel: VoiceBasedChannel,
    private resolveParticipant: ParticipantResolver,
    private onSegment: SegmentListener = () => {},
    private log: (msg: string) => void = console.log,
  ) {
    this.paths = sessionPaths(sessionId);
  }

  async start() {
    fs.mkdirSync(this.paths.audio, { recursive: true });
    this.writeTimeline(null);

    const connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.channel.guild.id,
      adapterCreator: this.channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must be undeafened to receive audio
      selfMute: true,
    });
    this.connection = connection;
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    connection.receiver.speaking.on("start", (userId) => {
      if (this.stopping) return;
      void this.capture(userId).catch((err) => this.log(`[recorder] capture ${userId} failed: ${err}`));
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Try to ride out channel moves / brief network drops before giving up.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.stopping) this.log(`[recorder] ${this.sessionId}: lost voice connection`);
        connection.destroy();
      }
    });
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
      this.writeTimeline(null);
      if (receiver.subscriptions.has(userId)) return; // raced with another start event
    }

    const startMs = Date.now() - this.startedAtMs;
    const userDir = path.join(this.paths.audio, userId);
    fs.mkdirSync(userDir, { recursive: true });
    const file = path.join(userDir, `${String(startMs).padStart(9, "0")}.wav`);

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 320 }); // 20 ms frames
    const wav = new WavFileWriter(file, SAMPLE_RATE, CHANNELS);

    const job = pipeline(opus, decoder, wav)
      .catch((err) => {
        // Corrupt/undecryptable packets end the stream; keep whatever was written.
        if (!this.stopping) this.log(`[recorder] stream error for ${userId}: ${err?.message ?? err}`);
      })
      .then(() => {
        const durationMs = wav.dataBytes / BYTES_PER_MS;
        if (durationMs < MIN_SEGMENT_MS) {
          fs.rmSync(file, { force: true });
          return;
        }
        const segment = {
          discordId: userId,
          startMs,
          endMs: Math.round(startMs + durationMs),
          file: path.relative(this.paths.dir, file).split(path.sep).join("/"),
        };
        this.segments.push(segment);
        this.writeTimeline(null); // before the clip can be deleted, so the timeline always lists it
        const names = [...this.participants.values()].flatMap((p) => (p.character ? [p.character] : []));
        this.onSegment(segment.file, names);
      })
      .finally(() => this.active.delete(job));
    this.active.add(job);
  }

  /** Leave the channel, flush every open segment, and finalize timeline.json. */
  async stop(): Promise<Timeline> {
    this.stopping = true;
    const receiver = this.connection?.receiver;
    if (receiver) {
      for (const stream of receiver.subscriptions.values()) stream.push(null);
    }
    await Promise.allSettled([...this.active]);
    this.connection?.destroy();
    this.connection = null;
    return this.writeTimeline(new Date().toISOString());
  }

  private writeTimeline(endedAt: string | null): Timeline {
    const timeline: Timeline = {
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
    const tmp = `${this.paths.timeline}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(timeline, null, 2));
    fs.renameSync(tmp, this.paths.timeline);
    return timeline;
  }
}
