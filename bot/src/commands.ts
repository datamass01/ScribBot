import {
  AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type Client,
  type SendableChannels,
  type VoiceBasedChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { llmConfigProblem } from "./summarize/readiness.js";
import { config } from "./config.js";
import { ALL_CAMPAIGNS, UNASSIGNED_FOLDER, campaignName, type SessionRow, type Store } from "./db.js";
import { bus } from "./events.js";
import { resolveParticipant, speakerLabel } from "./participants.js";
import { recordingNotice } from "./notice.js";
import { foundryActorsFile, sessionPaths } from "./paths.js";
import { linksToWrite, unlink, type RosterLink } from "./links.js";
import { formatGap, mergeSessions } from "./merge.js";
import { isProcessing, makeLiveTranscriber, processBlocker, processSession, reviseSession } from "./pipeline.js";
import { SessionRecorder, type RecorderOptions } from "./recorder.js";
import { SHUTDOWN_NOTE, defaultSessionToProcess, lastActivityMs } from "./recovery.js";
import { readTimeline } from "./timeline.js";
import type { SummaryFile } from "./summarize/schema.js";
import { backlogMinutes, workerHealth } from "./worker-client.js";
import { findStoryFile, loadStory } from "./story.js";
import { readSummaryFile } from "./summarize/summarize.js";
import { announceStory, announceSummary, approve, reviewState, type ReviewKind } from "./review.js";

/** What the Console can post to Discord (`postToDiscord`). */
export type DiscordPost = "summary" | "story" | "transcript";
/** Discord's upload limit for servers without boosts. */
const DISCORD_FILE_LIMIT = 10 * 1024 * 1024;

export const scribCommand = new SlashCommandBuilder()
  .setName("scrib")
  .setDescription("ScribBot session recorder")
  .setDMPermission(false)
  .addSubcommand((s) => s.setName("start").setDescription("Join your voice channel and start recording the session"))
  .addSubcommand((s) => s.setName("stop").setDescription("Stop recording, then transcribe and summarize"))
  .addSubcommand((s) => s.setName("status").setDescription("Show recording and processing status"))
  .addSubcommand((s) =>
    s
      .setName("map")
      .setDescription("Map a Discord user to their Foundry character")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("character")
          .setDescription("Foundry user/character (synced from Foundry), or any character name")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("unmap")
      .setDescription("Remove a user's character mapping")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("gm")
      .setDescription("Mark (or unmark) a user as the GM: their speech is narration and NPCs")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))
      .addBooleanOption((o) => o.setName("is_gm").setDescription("Default: true")),
  )
  .addSubcommand((s) => s.setName("mappings").setDescription("List who is mapped to which character"))
  .addSubcommand((s) => s.setName("sessions").setDescription("List recent sessions"))
  .addSubcommand((s) =>
    s
      .setName("process")
      .setDescription("Resume or re-run transcription + summary for a session")
      .addStringOption((o) => o.setName("session").setDescription("Session number (default: latest)"))
      .addBooleanOption((o) => o.setName("retranscribe").setDescription("Redo the speech-to-text transcription too")),
  )
  .addSubcommand((s) =>
    s
      .setName("summarize")
      .setDescription("Re-run only the AI summary (e.g. after editing campaign context)")
      .addStringOption((o) => o.setName("session").setDescription("Session number (default: latest)")),
  )
  .addSubcommand((s) =>
    s
      .setName("story")
      .setDescription("Import a session's story write-up into Foundry as a journal entry")
      .addStringOption((o) => o.setName("session").setDescription("Session number (default: latest with a story)")),
  )
  .addSubcommand((s) =>
    s
      .setName("approve")
      .setDescription("Approve a summary or story (reviewed in the ScribBot Console) and send it to Foundry")
      .addStringOption((o) => o.setName("session").setDescription("Session number (default: latest awaiting review)"))
      .addStringOption((o) =>
        o.setName("what").setDescription("Default: summary").addChoices({ name: "summary", value: "summary" }, { name: "story", value: "story" }),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("revise")
      .setDescription("Ask the LLM to correct a summary before it goes to Foundry")
      .addStringOption((o) => o.setName("feedback").setDescription("What to correct, e.g. \"the innkeeper is Brannoc, not Brandon\"").setRequired(true).setMaxLength(2000))
      .addStringOption((o) => o.setName("session").setDescription("Session number (default: latest with a summary)")),
  )
  .addSubcommand((s) =>
    s
      .setName("merge")
      .setDescription("Merge an interrupted game's continuation session into the one it continues")
      .addStringOption((o) => o.setName("a").setDescription("Session number to keep (the first part)").setRequired(true))
      .addStringOption((o) => o.setName("b").setDescription("Session number to merge in (the continuation)").setRequired(true)),
  );

/** Whether the bot may join a voice channel: it needs View Channel and Connect there. */
function botCanJoin(voice: VoiceBasedChannel, me: GuildMember | null) {
  const perms = me ? voice.permissionsFor(me) : null;
  return Boolean(perms?.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.Connect));
}

interface ActiveRecording {
  recorder: SessionRecorder;
  session: SessionRow;
  textChannelId: string | null;
}

export class CommandHandler {
  private recordings = new Map<string, ActiveRecording>();

  constructor(
    private client: Client,
    private store: Store,
  ) {}

  /** The session currently recording in any guild (the Foundry module only tracks one). */
  currentRecording(): SessionRow | null {
    const first = this.recordings.values().next();
    return first.done ? null : this.store.getSession(first.value.session.id) ?? null;
  }

  /** Live details of every recording in progress, for the monitor dashboard. */
  activeRecordings() {
    return [...this.recordings.values()].map(({ recorder, session }) => ({
      sessionId: session.id,
      number: session.number,
      guild: recorder.channel.guild.name,
      channel: recorder.channel.name,
      startedAt: new Date(recorder.startedAtMs).toISOString(),
      clips: recorder.segmentCount,
      connection: recorder.connectionState,
      speakingNow: recorder.speakingNow,
      speakers: recorder.speakers.map((p) => ({
        discordId: p.discordId,
        displayName: p.displayName,
        character: p.character,
        isGm: p.isGm,
      })),
    }));
  }

  async handle(i: ChatInputCommandInteraction) {
    if (!i.inCachedGuild()) {
      await i.reply({ content: "ScribBot only works in servers.", flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = i.options.getSubcommand();
    try {
      switch (sub) {
        case "start":
          return await this.start(i);
        case "stop":
          return await this.stop(i);
        case "status":
          return await this.status(i);
        case "map":
          return await this.map(i);
        case "unmap":
          return await this.unmap(i);
        case "gm":
          return await this.gm(i);
        case "mappings":
          return await this.listMappings(i);
        case "sessions":
          return await this.listSessions(i);
        case "process":
          return await this.process(i, false);
        case "summarize":
          return await this.process(i, true);
        case "story":
          return await this.story(i);
        case "merge":
          return await this.merge(i);
        case "approve":
          return await this.approve(i);
        case "revise":
          return await this.revise(i);
      }
    } catch (err) {
      const content = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[commands] /scrib ${sub} failed:`, err);
      if (i.deferred || i.replied) await i.editReply({ content }).catch(() => {});
      else await i.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  async autocomplete(i: AutocompleteInteraction) {
    const typed = i.options.getFocused().toLowerCase();
    const choices = this.store
      .getRoster()
      .filter((r) => r.actor_name || r.is_gm)
      .map((r) => ({
        name: r.actor_name ? `${r.actor_name} (Foundry user: ${r.user_name})` : `${r.user_name} (GM)`,
        value: `foundry:${r.foundry_user_id}`,
      }))
      .filter((c) => c.name.toLowerCase().includes(typed))
      .slice(0, 25);
    await i.respond(choices);
  }

  // ---------- recording ----------

  private async start(i: ChatInputCommandInteraction<"cached">) {
    if (this.recordings.has(i.guildId)) {
      await i.reply({ content: "Already recording in this server. Use `/scrib stop` first.", flags: MessageFlags.Ephemeral });
      return;
    }
    const voice = i.member.voice.channel;
    if (!voice) {
      await i.reply({ content: "Join a voice channel first, then run `/scrib start`.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!botCanJoin(voice, i.guild.members.me)) {
      await i.reply({ content: `I need **View Channel** and **Connect** in ${voice}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    const { text } = await this.beginRecording(i.guildId, voice, i.channelId);
    await i.editReply(text);
  }

  /**
   * Creates the session, joins the voice channel and returns the recording notice to post.
   * Shared by `/scrib start` and the Console; the callers check permissions first.
   */
  private async beginRecording(guildId: string, voice: VoiceBasedChannel, textChannelId: string | null, campaignId?: number) {
    // Warn early (but still record) if the worker is down: transcription can run later.
    let workerNote = "";
    try {
      await workerHealth();
    } catch {
      workerNote = "\n⚠️ The transcription worker is not reachable right now; start it before `/scrib stop`.";
    }

    const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const session = this.store.createSession({
      id,
      guildId,
      channelId: voice.id,
      textChannelId,
      startedAt,
      campaignId,
    });

    // Seed the session's copy of the character and NPC details with the last roster sync;
    // Foundry replaces it with fresh ones when it hears "session.started" (and again at stop).
    try {
      if (fs.existsSync(foundryActorsFile())) {
        fs.mkdirSync(sessionPaths(id).recording, { recursive: true });
        fs.copyFileSync(foundryActorsFile(), sessionPaths(id).recordingActors);
        fs.copyFileSync(foundryActorsFile(), sessionPaths(id).actors);
      }
    } catch (err) {
      console.warn(`[commands] could not copy Foundry actor details into session ${id}: ${err}`);
    }

    const recorder = this.makeRecorder(id, voice, textChannelId);
    try {
      await recorder.start();
    } catch (err) {
      this.store.setSessionStatus(id, "failed", `Could not join voice: ${err}`);
      throw new Error(`Could not connect to ${voice.name}: ${err instanceof Error ? err.message : err}`);
    }
    this.recordings.set(guildId, { recorder, session, textChannelId });
    bus.emitEvent({ type: "session.started", sessionId: id, number: session.number, startedAt });

    const mapped = this.describeVoiceMembers(guildId, voice.members.filter((m) => !m.user.bot).values(), session.campaign_id ?? ALL_CAMPAIGNS);
    const campaign = session.campaign_id == null ? null : this.store.getCampaign(session.campaign_id);
    const campaignLine = campaign && campaign.folder !== UNASSIGNED_FOLDER ? `📖 Campaign: **${campaignName(campaign)}**\n` : "";
    return {
      session,
      text: `${recordingNotice({ sessionNumber: session.number, channel: String(voice), llm: config.llm, autoSummarize: config.autoSummarize })}\n\n${campaignLine}${mapped}${workerNote}`,
    };
  }

  private makeRecorder(sessionId: string, voice: VoiceBasedChannel, textChannelId: string | null, resume?: RecorderOptions["resume"]) {
    const number = () => this.store.getSession(sessionId)?.number ?? "?";
    return new SessionRecorder(
      sessionId,
      voice,
      async (userId) => {
        const member = await voice.guild.members.fetch(userId).catch(() => null);
        if (!member || member.user.bot) return null;
        // The mappings of the campaign this recording is filed under (looked up now: it can be moved).
        const campaignId = this.store.getSession(sessionId)?.campaign_id ?? ALL_CAMPAIGNS;
        return resolveParticipant(userId, member.displayName, this.store.getMappings(voice.guild.id, campaignId), this.store.getRoster());
      },
      {
        onSegment: makeLiveTranscriber(sessionPaths(sessionId).recording),
        resume,
        onConnection: (e) => {
          const text =
            e.type === "reconnecting"
              ? `⚠️ Session ${number()}: lost the voice connection. Trying to rejoin ${voice}…`
              : e.type === "restored"
                ? `✅ Session ${number()}: back in ${voice} after ${formatGap(e.gapMs / 1000)}. Recording continues; speech during the gap wasn't recorded.`
                : `❌ Session ${number()}: couldn't rejoin ${voice} after ${e.attempts} tries. I'll keep trying every minute. ` +
                  "`/scrib stop` ends the session and keeps everything recorded so far.";
          void this.tell(textChannelId, text);
        },
      },
    );
  }

  /**
   * After a restart (02 S3): rejoin the voice channel of each session that was recording when the
   * bot went down, continuing the same session on the same clock. Anything that can't be resumed is
   * marked failed and the table is told right away.
   */
  async resumeInterrupted(candidates: SessionRow[]) {
    for (const s of candidates) {
      const fail = async (why: string) => {
        const error = `Interrupted while recording (bot restarted; ${why}). Run /scrib process session:${s.number} to transcribe what was recorded.`;
        this.store.setSessionStatus(s.id, "failed", error);
        bus.emitEvent({ type: "session.status", sessionId: s.id, status: "failed", error });
        console.log(`[commands] session ${s.number} not resumed: ${why}`);
        await this.tell(
          s.text_channel_id,
          `⚠️ ScribBot restarted and couldn't resume recording session ${s.number} (${why}). ` +
            `Everything recorded before the restart is kept: run \`/scrib process session:${s.number}\` to transcribe it, ` +
            "or `/scrib start` to record the rest as a new session (`/scrib merge` can join the two afterwards).",
        );
      };
      try {
        if (this.recordings.has(s.guild_id)) {
          await fail("another recording is already running in this server");
          continue;
        }
        const channel = await this.client.channels.fetch(s.channel_id).catch(() => null);
        if (!channel?.isVoiceBased()) {
          await fail("its voice channel is gone");
          continue;
        }
        if (!channel.members.some((m) => !m.user.bot)) {
          await fail("nobody is in the voice channel any more");
          continue;
        }
        const paths = sessionPaths(s.id);
        const timeline = readTimeline(paths.recording);
        const last = lastActivityMs(s, paths);
        const recorder = this.makeRecorder(s.id, channel, s.text_channel_id, {
          startedAtMs: Date.parse(timeline.startedAt),
          participants: timeline.participants,
          segments: timeline.segments,
        });
        await recorder.start();
        this.recordings.set(s.guild_id, { recorder, session: s, textChannelId: s.text_channel_id });
        this.store.setSessionStatus(s.id, "recording", null);
        bus.emitEvent({ type: "session.started", sessionId: s.id, number: s.number, startedAt: timeline.startedAt });
        const gap = formatGap((Date.now() - last) / 1000);
        console.log(`[commands] session ${s.number}: recording resumed in ${channel.name} (gap ${gap})`);
        await this.tell(
          s.text_channel_id,
          `⚠️ ScribBot restarted; **recording of session ${s.number} resumed** in ${channel} (gap ${gap}). ` +
            "Speech during the gap wasn't recorded.",
        );
      } catch (err) {
        await fail(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Tell the table about sessions a restart interrupted that weren't resumed (02 S3, fix 3). */
  async announceInterrupted(sessions: SessionRow[]) {
    for (const s of sessions) {
      await this.tell(
        s.text_channel_id,
        `⚠️ ScribBot restarted while session ${s.number} was ${s.status}. ` +
          `Nothing recorded is lost: run \`/scrib process session:${s.number}\` to finish it.`,
      );
    }
  }

  /** Run the pipeline for sessions a clean shutdown stopped mid-recording (02 S8). */
  resumeProcessing(sessions: SessionRow[]) {
    for (const s of sessions) {
      console.log(`[commands] session ${s.number} was stopped by a shutdown; processing it now`);
      this.runPipeline(s.id, s.text_channel_id);
    }
  }

  /**
   * On SIGINT/SIGTERM (02 S8): close every open clip and finalize timeline.json, bounded by
   * `timeoutMs`, and leave the session for the pipeline to finish on the next start.
   */
  async stopAll(timeoutMs = 10_000) {
    const all = [...this.recordings.values()];
    this.recordings.clear();
    await Promise.all(
      all.map(async (active) => {
        const { session } = active;
        try {
          const timeline = await Promise.race([
            active.recorder.stop(),
            sleep(timeoutMs).then(() => {
              throw new Error(`still flushing after ${timeoutMs / 1000} s`);
            }),
          ]);
          this.store.endSession(session.id, timeline.endedAt!);
          this.store.setSessionStatus(session.id, "failed", SHUTDOWN_NOTE);
          console.log(`[scribbot] recording ${session.number} stopped and saved (${timeline.segments.length} clips)`);
          await Promise.race([
            this.tell(
              active.textChannelId,
              `⏹️ ScribBot is shutting down: **session ${session.number} recording stopped and saved** ` +
                `(${timeline.segments.length} clips). It will be transcribed when the bot starts again.`,
            ),
            sleep(3000),
          ]);
        } catch (err) {
          this.store.setSessionStatus(
            session.id,
            "failed",
            `Interrupted while recording (shutdown: ${(err as Error).message}). Run /scrib process session:${session.number}.`,
          );
          console.error(`[scribbot] recording ${session.number} could not be finalized:`, err);
        }
      }),
    );
  }

  private backlogWarned = new Set<string>();

  /** Warn each recording's text channel once when the worker falls behind (02 S5, fix 3). */
  async checkBacklog(thresholdMinutes: number) {
    if (thresholdMinutes <= 0 || !this.recordings.size) return;
    let health;
    try {
      health = await workerHealth(2000);
    } catch {
      return; // unreachable is reported by /status; clips wait on disk
    }
    const minutes = backlogMinutes(health);
    if (minutes == null || minutes < thresholdMinutes) return;
    for (const { session, textChannelId } of this.recordings.values()) {
      if (this.backlogWarned.has(session.id)) continue;
      this.backlogWarned.add(session.id);
      console.warn(`[commands] worker backlog: ${health.queued} clips, ~${Math.round(minutes)} min`);
      await this.tell(
        textChannelId,
        `🐢 Transcription is about ${Math.round(minutes)} min behind (${health.queued} clips queued). ` +
          "Nothing is lost: clips wait on disk, but the transcript will take longer after `/scrib stop`.",
      );
    }
  }

  private describeVoiceMembers(guildId: string, members: Iterable<GuildMember>, campaignId = this.playingCampaignId()) {
    const mappings = this.store.getMappings(guildId, campaignId);
    const roster = this.store.getRoster();
    const lines = [...members].map((m) => {
      const p = resolveParticipant(m.id, m.displayName, mappings, roster);
      const unmapped = !p.isGm && !p.character ? " ⚠️ *unmapped: `/scrib map`*" : "";
      return `• ${speakerLabel(p)}${unmapped}`;
    });
    return lines.length ? `**At the table:**\n${lines.join("\n")}` : "";
  }

  private async stop(i: ChatInputCommandInteraction<"cached">) {
    const active = this.recordings.get(i.guildId);
    if (!active) {
      await i.reply({ content: "Not recording in this server.", flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    const text = await this.endRecording(i.guildId, active);
    await i.editReply(text);
    this.runPipeline(active.session.id, i.channelId);
  }

  /** Stops a recording and returns the message for the table. Shared by `/scrib stop` and the Console. */
  private async endRecording(guildId: string, active: ActiveRecording) {
    this.recordings.delete(guildId);
    const timeline = await active.recorder.stop();
    const endedAt = timeline.endedAt!;
    this.store.endSession(active.session.id, endedAt);
    bus.emitEvent({
      type: "session.stopped",
      sessionId: active.session.id,
      number: active.session.number,
      startedAt: timeline.startedAt,
      endedAt,
    });

    const minutes = Math.round((Date.parse(endedAt) - Date.parse(timeline.startedAt)) / 60000);
    return (
      `⏹️ **Session ${active.session.number} recording stopped**: ${minutes} min, ` +
      `${timeline.segments.length} clips from ${timeline.participants.length} speaker(s).\n` +
      `Transcribing and summarizing now. I'll post here when it's done.`
    );
  }

  /** Set by index.ts when the headless Foundry client is on: waits for a just-stopped session's chat log. */
  awaitChatlog: ((sessionId: string) => Promise<void>) | null = null;

  /** `summarize` defaults to AUTO_SUMMARIZE; `/scrib summarize` passes true explicitly. */
  private runPipeline(sessionId: string, channelId: string | null, opts: { retranscribe?: boolean; summarize?: boolean } = {}) {
    const { summarize = config.autoSummarize, ...rest } = opts;
    void processSession(this.store, sessionId, {
      ...rest,
      skipSummary: !summarize,
      beforeSummary: () => this.awaitChatlog?.(sessionId) ?? Promise.resolve(),
      notify: (text) => this.send(channelId, text),
      onSummary: (file, { held }) => this.summaryNotice(channelId, file, held),
    }).catch(() => {
      // already reported via notify
    });
  }

  /** Posts to a text channel; throws if Discord refuses. See `tell()` for notices that mustn't. */
  private async send(channelId: string | null, payload: string | Parameters<SendableChannels["send"]>[0]) {
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel?.isSendable()) await channel.send(payload);
  }

  /**
   * Best-effort notice to the table: a failed post is logged, never thrown, so it can't stop the
   * recording or the shutdown it reports on.
   */
  private async tell(channelId: string | null, text: string) {
    try {
      await this.send(channelId, text);
    } catch (err) {
      console.warn(`[commands] couldn't post to channel ${channelId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * The table hears that a summary is ready, never its text: the content goes to Discord only when
   * someone posts it from the Console (`postToDiscord`).
   */
  private async summaryNotice(channelId: string | null, f: SummaryFile, held: boolean, revised = false) {
    const what = revised ? "summary was revised" : "summary is written";
    const next = held
      ? "It's waiting for review in the ScribBot Console before it goes to Foundry."
      : "It was sent to Foundry.";
    await this.tell(channelId, `📜 Session ${f.sessionNumber}'s ${what} (${f.model}). ${next}`);
  }

  /**
   * Posts a session's summary, story or transcript to a Discord text channel, on request from the
   * Console. Nothing else posts session content to Discord. `channelId` must be in the session's
   * server; left out, the session's text channel.
   */
  async postToDiscord(session: SessionRow, what: DiscordPost, channelId?: string) {
    if (!this.client.isReady()) throw new Error("The bot isn't connected to Discord yet.");
    const guild = this.client.guilds.cache.get(session.guild_id);
    if (!guild) throw new Error("The bot isn't in this session's Discord server any more.");
    const target = channelId ?? session.text_channel_id;
    if (!target) throw new Error("This session has no text channel; pick one.");
    const channel = guild.channels.cache.get(target);
    if (!channel?.isSendable()) throw new Error("Pick a text channel in the session's server that the bot can post in.");

    const p = sessionPaths(session.id);
    const attach = (file: string, name: string) => {
      const size = fs.statSync(file).size;
      if (size > DISCORD_FILE_LIMIT) {
        throw new Error(`${name} is ${Math.ceil(size / 1024 / 1024)} MB; Discord takes files up to ${DISCORD_FILE_LIMIT / 1024 / 1024} MB.`);
      }
      return new AttachmentBuilder(file, { name });
    };
    let payload: Parameters<SendableChannels["send"]>[0];
    if (what === "summary") {
      if (!fs.existsSync(p.summary)) throw new Error(`Session ${session.number} has no summary yet.`);
      const f = readSummaryFile(session.id);
      const s = f.summary;
      const embed = new EmbedBuilder()
        .setTitle(`Session ${f.sessionNumber}: ${s.title}`)
        .setDescription(s.recap.length > 3900 ? `${s.recap.slice(0, 3900)}…` : s.recap)
        .setColor(0x8b5cf6)
        .setFooter({ text: `Summarized by ${f.model}. Full notes attached.` });
      const quotes = s.quotes.slice(0, 3).map((q) => `> "${q.text}"\n> — **${q.character}**`);
      if (quotes.length) embed.addFields({ name: "Quotes", value: quotes.join("\n\n").slice(0, 1024) });
      if (s.hooks.length) embed.addFields({ name: "Open threads", value: s.hooks.map((h) => `• ${h}`).join("\n").slice(0, 1024) });
      payload = { embeds: [embed], files: fs.existsSync(p.summaryMd) ? [attach(p.summaryMd, `session-${f.sessionNumber}.md`)] : [] };
    } else if (what === "story") {
      const found = findStoryFile(session.id);
      if (!found) throw new Error(`Session ${session.number} has no story write-up.`);
      const story = loadStory(this.store, session);
      const embed = new EmbedBuilder()
        .setTitle(story.title)
        .setDescription(`The story of session ${story.sessionNumbers.join(" + ")}, attached.`)
        .setColor(0x8b5cf6);
      payload = { embeds: [embed], files: [attach(found.file, `session-${story.sessionNumber}-story.md`)] };
    } else {
      if (!fs.existsSync(p.transcriptMd)) throw new Error(`Session ${session.number} has no transcript yet.`);
      payload = {
        content: `📄 Session ${session.number}'s transcript.`,
        files: [attach(p.transcriptMd, `session-${session.number}-transcript.md`)],
      };
    }
    await channel.send(payload);
    console.log(`[commands] session ${session.number}: ${what} posted to #${channel.name} from the Console`);
    return { channelId: channel.id, channelName: channel.name };
  }

  // ---------- info ----------

  private async status(i: ChatInputCommandInteraction<"cached">) {
    const lines: string[] = [];
    const active = this.recordings.get(i.guildId);
    if (active) {
      const mins = Math.round((Date.now() - active.recorder.startedAtMs) / 60000);
      lines.push(
        `🔴 Recording session ${active.session.number}: ${mins} min, ${active.recorder.segmentCount} clips, ${active.recorder.speakerCount} speaker(s).`,
      );
    } else {
      lines.push("Not recording.");
    }
    const latest = this.store.latestSession(i.guildId);
    if (latest && latest.id !== active?.session.id) {
      lines.push(`Last session: #${latest.number}, **${latest.status}**${latest.error ? `: ${latest.error}` : ""}`);
    }
    try {
      const h = await workerHealth();
      lines.push(`Worker: ✅ ${h.model} on ${h.device}`);
    } catch {
      lines.push("Worker: ❌ unreachable");
    }
    lines.push(`Summarizer: ${config.llm.provider}${config.llm.model ? ` / ${config.llm.model}` : ""}`);
    lines.push(`Foundry roster: ${this.store.getRoster().length} user(s) synced`);
    await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }

  private async listSessions(i: ChatInputCommandInteraction<"cached">) {
    const rows = this.store
      .listSessions(15)
      .filter((s) => s.guild_id === i.guildId)
      .map((s) => `#${s.number}  ${s.started_at.slice(0, 16).replace("T", " ")}  **${s.status}**${s.error ? `: ${s.error.slice(0, 80)}` : ""}`);
    await i.reply({ content: rows.join("\n") || "No sessions yet.", flags: MessageFlags.Ephemeral });
  }

  // ---------- mappings ----------

  private assertCanEdit(i: ChatInputCommandInteraction<"cached">, targetId: string) {
    if (targetId !== i.user.id && !i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error("You can only change your own mapping (Manage Server is needed to change others).");
    }
  }

  private async map(i: ChatInputCommandInteraction<"cached">) {
    const user = i.options.getUser("user", true);
    this.assertCanEdit(i, user.id);
    const value = i.options.getString("character", true).trim();
    await i.reply(`✅ ${user} → ${this.setMapping(i.guildId, user.id, value)}${this.campaignSuffix()}`);
  }

  /**
   * The campaign `/scrib map`, `unmap` and `gm` change, and the Console unless it names one: the
   * campaign being played, or every campaign (ALL_CAMPAIGNS) while there is none yet.
   */
  playingCampaignId() {
    const c = this.store.defaultCampaign({ create: false });
    return c && c.folder !== UNASSIGNED_FOLDER ? c.id : ALL_CAMPAIGNS;
  }

  /** " (campaign Name)" after a mapping reply, when there are campaigns to tell apart. */
  private campaignSuffix() {
    const id = this.playingCampaignId();
    const c = id === ALL_CAMPAIGNS ? null : this.store.getCampaign(id);
    return c && this.store.listCampaigns().filter((x) => x.folder !== UNASSIGNED_FOLDER).length > 1 ? ` (campaign ${campaignName(c)})` : "";
  }

  /**
   * Whether the synced Foundry roster is this campaign's world, so its Foundry users can be mapped
   * and their "Discord ID" flags written. Unknown worlds (a campaign without one, an older module
   * that doesn't say) count as a match.
   */
  private rosterIsFor(campaignId: number) {
    if (campaignId === ALL_CAMPAIGNS) return true;
    const world = this.store.getCampaign(campaignId)?.world_id;
    const rosterWorld = this.store.getMeta("roster_world");
    return !world || !rosterWorld || world === rosterWorld;
  }

  /**
   * `value` is `foundry:<user id>` (a synced Foundry user) or any character name. Returns how it
   * reads, e.g. "**Thorin** (Foundry user Alice)". Shared by `/scrib map` and the Console.
   */
  setMapping(guildId: string, discordId: string, value: string, campaignId = this.playingCampaignId()) {
    value = value.trim();
    if (!value) throw new Error("Pick a character.");
    const previous = this.store.getMappings(guildId, campaignId).find((m) => m.discord_id === discordId);
    const linked = this.rosterIsFor(campaignId);
    if (value.startsWith("foundry:")) {
      if (!linked) {
        throw new Error(
          `The Foundry roster ScribBot has is from world ${this.store.getMeta("roster_world")}, not this campaign's. ` +
            "Open the campaign's world in Foundry so it syncs, or enter a character name.",
        );
      }
      const r = this.store.getRoster().find((x) => x.foundry_user_id === value.slice(8));
      if (!r) throw new Error("That Foundry user is no longer in the synced roster.");
      this.store.upsertMapping({
        campaignId,
        guildId,
        discordId,
        foundryUserId: r.foundry_user_id,
        actorId: r.actor_id,
        characterName: r.actor_name,
        isGm: Boolean(r.is_gm),
      });
      const links: RosterLink[] = [];
      if (previous?.foundry_user_id && previous.foundry_user_id !== r.foundry_user_id) links.push(unlink(previous.foundry_user_id, discordId));
      if (r.discord_id !== discordId) links.push({ foundryUserId: r.foundry_user_id, discordId });
      this.sendLinks(links);
      return `**${r.actor_name ?? "GM"}** (Foundry user ${r.user_name})`;
    }
    this.store.upsertMapping({ campaignId, guildId, discordId, foundryUserId: null, actorId: null, characterName: value });
    if (previous?.foundry_user_id && linked) this.sendLinks([unlink(previous.foundry_user_id, discordId)]);
    return `**${value}** (not linked to a Foundry actor)`;
  }

  /** Have the Foundry module store (or clear) "Discord ID" flags; GM-only there (05 C11). */
  private sendLinks(links: RosterLink[]) {
    if (!links.length) return;
    console.log(`[commands] Foundry link update: ${links.map((l) => `${l.foundryUserId}=${l.discordId ?? "(clear)"}`).join(", ")}`);
    bus.emitEvent({ type: "roster.link", links });
  }

  private async unmap(i: ChatInputCommandInteraction<"cached">) {
    const user = i.options.getUser("user", true);
    this.assertCanEdit(i, user.id);
    this.clearMapping(i.guildId, user.id);
    await i.reply({ content: `Removed mapping for ${user}${this.campaignSuffix()}.`, flags: MessageFlags.Ephemeral });
  }

  clearMapping(guildId: string, discordId: string, campaignId = this.playingCampaignId()) {
    const previous = this.store.getMappings(guildId, campaignId).find((m) => m.discord_id === discordId);
    this.store.deleteMapping(guildId, discordId, campaignId);
    if (previous?.foundry_user_id && this.rosterIsFor(campaignId)) this.sendLinks([unlink(previous.foundry_user_id, discordId)]);
  }

  private async gm(i: ChatInputCommandInteraction<"cached">) {
    const user = i.options.getUser("user", true);
    this.assertCanEdit(i, user.id);
    const isGm = i.options.getBoolean("is_gm") ?? true;
    this.setGm(i.guildId, user.id, isGm);
    await i.reply(isGm ? `🎲 ${user} is the GM.` : `${user} is no longer marked as GM.`);
  }

  setGm(guildId: string, discordId: string, isGm: boolean, campaignId = this.playingCampaignId()) {
    this.store.upsertMapping({ campaignId, guildId, discordId, isGm });
    if (isGm && this.rosterIsFor(campaignId)) this.sendLinks(linksToWrite(this.store.getCampaignMappings(campaignId), this.store.getRoster()));
  }

  private async listMappings(i: ChatInputCommandInteraction<"cached">) {
    const rows = this.store.getMappings(i.guildId, this.playingCampaignId()).map((m) => {
      const who = m.is_gm ? "GM" : (m.character_name ?? "?");
      return `<@${m.discord_id}> → **${who}**${m.actor_id ? " (Foundry actor linked)" : ""}`;
    });
    const voice = i.member.voice.channel;
    const unmapped =
      voice?.type === ChannelType.GuildVoice || voice?.type === ChannelType.GuildStageVoice
        ? `\n\n${this.describeVoiceMembers(i.guildId, voice.members.filter((m) => !m.user.bot).values())}`
        : "";
    const suffix = this.campaignSuffix();
    await i.reply({
      content: (suffix ? `Mappings${suffix}:\n` : "") + (rows.join("\n") || "No mappings yet. Use `/scrib map`.") + unmapped,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  // ---------- reprocessing ----------

  private async process(i: ChatInputCommandInteraction<"cached">, summaryOnly: boolean) {
    const ref = i.options.getString("session");
    const session = ref ? this.store.findSession(i.guildId, ref) : defaultSessionToProcess(this.store.listSessions(1000), i.guildId);
    if (!session) throw new Error(ref ? "No such session." : "No finished session to process.");
    const retranscribe = !summaryOnly && (i.options.getBoolean("retranscribe") ?? false);
    await this.checkProcess(session, summaryOnly, retranscribe);

    await i.reply(`🔄 ${summaryOnly ? "Summarizing" : "Processing"} session ${session.number}${retranscribe ? " (re-transcribing)" : ""}…`);
    // /scrib summarize is the explicit request to send the transcript to the LLM.
    this.runPipeline(session.id, i.channelId, { retranscribe, ...(summaryOnly ? { summarize: true } : {}) });
  }

  /** Why `/scrib process` or `summarize` would be refused, thrown as an Error. Shared with the Console. */
  private async checkProcess(session: SessionRow, summaryOnly: boolean, retranscribe: boolean) {
    const blocker = processBlocker(session, { retranscribe });
    if (blocker) throw new Error(blocker);
    if (session.status === "recording") throw new Error(`Session ${session.number} is still recording.`);
    if (summaryOnly) {
      if (!fs.existsSync(sessionPaths(session.id).transcriptJson)) {
        throw new Error("That session has no transcript yet; use `/scrib process` instead.");
      }
      // Say why it would fail before anything starts (02 S14).
      const problem = await llmConfigProblem();
      if (problem) throw new Error(problem);
    }
  }

  private async story(i: ChatInputCommandInteraction<"cached">) {
    const ref = i.options.getString("session");
    const session = ref
      ? this.store.findSession(i.guildId, ref)
      : this.store.listSessions(1000).find((s) => s.guild_id === i.guildId && findStoryFile(s.id) !== null);
    if (!session) throw new Error(ref ? "No such session." : "No session has a story yet. Write one with the summarize-session skill.");
    if (session.deleted_at) throw new Error(`Session ${session.number} is in the trash. Restore it first.`);
    const story = announceStory(this.store, session);
    await i.reply(
      `📜 Sent **${story.title}** (session ${story.sessionNumbers.join(" + ")}) to Foundry. ` +
        "The bridge client creates the journal entry, or updates it if it's already there.",
    );
  }

  // ---------- review before Foundry ----------

  /** Approving or revising is for the GM (mapped with /scrib gm) or someone who can manage the server. */
  private requireReviewer(i: ChatInputCommandInteraction<"cached">, session: SessionRow) {
    if (i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return;
    const campaignId = session.campaign_id ?? this.playingCampaignId();
    if (this.store.getMappings(i.guildId, campaignId).some((m) => m.discord_id === i.user.id && m.is_gm)) return;
    throw new Error("Only the GM (see `/scrib gm`) or someone with Manage Server can approve or revise what goes to Foundry.");
  }

  private async approve(i: ChatInputCommandInteraction<"cached">) {
    const kind = (i.options.getString("what") ?? "summary") as ReviewKind;
    const ref = i.options.getString("session");
    const mine = this.store.listSessions(1000).filter((s) => s.guild_id === i.guildId && !s.deleted_at && !s.merged_into_id);
    const session = ref
      ? this.store.findSession(i.guildId, ref)
      : (mine.find((s) => reviewState(this.store, s, kind)?.approved === false) ?? mine.find((s) => reviewState(this.store, s, kind)));
    if (!session) throw new Error(ref ? "No such session." : `No session has a ${kind} to approve.`);
    if (session.deleted_at) throw new Error(`Session ${session.number} is in the trash. Restore it first.`);
    this.requireReviewer(i, session);
    if (isProcessing(session.id)) throw new Error(`Session ${session.number} is being processed; approve it once that's done.`);
    approve(this.store, session, kind);
    if (kind === "story") {
      const story = announceStory(this.store, session);
      await i.reply(`✅ Approved **${story.title}** (session ${story.sessionNumbers.join(" + ")}) and sent it to Foundry.`);
    } else {
      const summary = announceSummary(this.store, session, { manual: true });
      await i.reply(`✅ Approved session ${session.number}'s summary, **${summary.title}**, and sent it to Foundry.`);
    }
  }

  private async revise(i: ChatInputCommandInteraction<"cached">) {
    const ref = i.options.getString("session");
    const session = ref
      ? this.store.findSession(i.guildId, ref)
      : this.store.listSessions(1000).find((s) => s.guild_id === i.guildId && !s.deleted_at && fs.existsSync(sessionPaths(s.id).summary));
    if (!session) throw new Error(ref ? "No such session." : "No session has a summary to revise.");
    this.requireReviewer(i, session);
    const feedback = i.options.getString("feedback", true);
    await this.checkRevise(session, feedback);
    await i.reply(`✏️ Asking the LLM to revise session ${session.number}'s summary. I'll say here when the new version is ready.`);
    this.runRevision(session.id, i.channelId, feedback);
  }

  /** Why a revision would be refused, thrown. Shared with the Console. */
  private async checkRevise(session: SessionRow, feedback: string) {
    const blocker = processBlocker(session);
    if (blocker) throw new Error(blocker);
    if (session.deleted_at) throw new Error(`Session ${session.number} is in the trash. Restore it first.`);
    if (!fs.existsSync(sessionPaths(session.id).summary)) throw new Error(`Session ${session.number} has no summary to revise. Summarize it first.`);
    if (!feedback.trim()) throw new Error("Say what to correct.");
    const problem = await llmConfigProblem();
    if (problem) throw new Error(problem);
  }

  private runRevision(sessionId: string, channelId: string | null, feedback: string) {
    void reviseSession(this.store, sessionId, feedback, {
      notify: (text) => this.send(channelId, text),
      onSummary: (file, { held }) => this.summaryNotice(channelId, file, held, true),
    }).catch(() => {
      // already reported via notify
    });
  }

  /** `/scrib revise` from the Console's review screen; the new version is posted in the session's text channel. */
  async reviseFromConsole(session: SessionRow, feedback: string) {
    await this.checkRevise(session, feedback);
    console.log(`[commands] session ${session.number}: summary revision requested from the Console`);
    this.runRevision(session.id, session.text_channel_id, feedback);
  }

  private async merge(i: ChatInputCommandInteraction<"cached">) {
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error("Merging sessions needs the Manage Server permission.");
    }
    const [a, b] = (["a", "b"] as const).map((name) => {
      const ref = i.options.getString(name, true).trim();
      const s = this.store.findSession(i.guildId, ref);
      if (!s) throw new Error(`No session ${ref}.`);
      return s;
    }) as [SessionRow, SessionRow];
    await i.reply(this.mergeInto(a, b));
  }

  /** Merges continuation session `b` into `a` and returns the message. Shared by `/scrib merge` and the Console. */
  mergeInto(a: SessionRow, b: SessionRow) {
    for (const s of [a, b]) {
      if (s.deleted_at) throw new Error(`Session ${s.number} is in the trash. Restore it first.`);
    }
    const r = mergeSessions(this.store, a.id, b.id, { isBusy: isProcessing });
    console.log(`[merge] session ${b.number} merged into session ${a.number} (${r.linesAdded} lines, gap ${formatGap(r.gapSec)})`);
    bus.emitEvent({ type: "session.status", sessionId: a.id, status: r.target.status, error: r.target.error });
    bus.emitEvent({ type: "session.status", sessionId: b.id, status: r.source.status, error: r.source.error });
    const warnings = r.warnings.map((w) => `\n⚠️ ${w}`).join("");
    return (
      `🔗 **Session ${b.number} merged into session ${a.number}**: ${r.linesAdded} transcript lines ` +
        `(gap ${formatGap(r.gapSec)}), ${r.chatAdded} chat messages, ${r.combatsAdded} combats` +
        `. Session ${b.number}'s recording moved into session ${a.number}'s folder` +
        `${r.archive ? `, with its own summary and story beside it` : ""}; nothing was deleted.` +
        `${warnings}\nRun \`/scrib summarize session:${a.number}\` to summarize the whole game.`
    );
  }

  // ---------- the Console (/admin/*, bot/src/api/admin.ts) ----------
  // Same checks and messages as the slash commands. The table still hears about everything in
  // the session's text channel; errors are thrown with a message the Console shows as is.

  isRecording(sessionId: string) {
    return [...this.recordings.values()].some((r) => r.session.id === sessionId);
  }

  /** Guilds the bot is in, their voice channels (who's in them, whether the bot may join) and text channels it can post in. */
  listChannels() {
    return this.client.guilds.cache.map((g) => {
      const me = g.members.me;
      const voice = g.channels.cache
        .filter((c): c is VoiceBasedChannel => c.isVoiceBased())
        .map((c) => ({
          id: c.id,
          name: c.name,
          canJoin: botCanJoin(c, me),
          members: c.members.filter((m) => !m.user.bot).map((m) => ({ id: m.id, name: m.displayName })),
        }));
      const text = g.channels.cache
        .filter((c) => c.type === ChannelType.GuildText)
        .filter((c) => {
          const perms = me ? c.permissionsFor(me) : null;
          return Boolean(perms?.has(PermissionFlagsBits.ViewChannel) && perms.has(PermissionFlagsBits.SendMessages));
        })
        .map((c) => ({ id: c.id, name: c.name }));
      const recording = this.recordings.get(g.id);
      return {
        id: g.id,
        name: g.name,
        recording: recording ? { sessionId: recording.session.id, number: recording.session.number } : null,
        lastTextChannelId: this.store.latestSession(g.id)?.text_channel_id ?? null,
        voice,
        text,
      };
    });
  }

  /** Starts recording from the Console. The recording notice goes to `textChannelId`, as `/scrib start` would post it. */
  async startFromConsole(opts: { guildId: string; voiceChannelId: string; textChannelId: string; campaignId?: number }) {
    if (!this.client.isReady()) throw new Error("The bot isn't connected to Discord yet.");
    const guild = this.client.guilds.cache.get(opts.guildId);
    if (!guild) throw new Error("The bot isn't in that server.");
    if (this.recordings.has(guild.id)) throw new Error("Already recording in this server. Stop that recording first.");
    const voice = guild.channels.cache.get(opts.voiceChannelId);
    if (!voice?.isVoiceBased()) throw new Error("That voice channel doesn't exist any more.");
    const text = guild.channels.cache.get(opts.textChannelId);
    if (!text?.isSendable()) throw new Error("Pick a text channel the bot can post in: the table must see the recording notice.");
    if (!botCanJoin(voice, guild.members.me)) {
      throw new Error(`The bot needs View Channel and Connect in ${voice.name}.`);
    }
    if (opts.campaignId != null && !this.store.getCampaign(opts.campaignId)) throw new Error("That campaign doesn't exist.");
    const { session, text: notice } = await this.beginRecording(guild.id, voice, text.id, opts.campaignId);
    console.log(`[commands] session ${session.number}: recording started from the Console in ${voice.name}`);
    await this.tell(text.id, notice);
    return session;
  }

  /** Stops a recording from the Console; the table is told in the session's text channel, then it's processed. */
  async stopFromConsole(sessionId: string) {
    const entry = [...this.recordings.entries()].find(([, r]) => r.session.id === sessionId);
    if (!entry) throw new Error("That session isn't recording.");
    const [guildId, active] = entry;
    const text = await this.endRecording(guildId, active);
    console.log(`[commands] session ${active.session.number}: recording stopped from the Console`);
    await this.tell(active.textChannelId, text);
    this.runPipeline(active.session.id, active.textChannelId);
    return active.session;
  }

  /** `/scrib process` (or `summarize` with summaryOnly) from the Console; results are posted in the session's text channel. */
  async processFromConsole(session: SessionRow, opts: { summaryOnly?: boolean; retranscribe?: boolean }) {
    const summaryOnly = Boolean(opts.summaryOnly);
    const retranscribe = !summaryOnly && Boolean(opts.retranscribe);
    await this.checkProcess(session, summaryOnly, retranscribe);
    console.log(`[commands] session ${session.number}: ${summaryOnly ? "summarize" : "process"} requested from the Console${retranscribe ? " (re-transcribing)" : ""}`);
    this.runPipeline(session.id, session.text_channel_id, { retranscribe, ...(summaryOnly ? { summarize: true } : {}) });
  }

  /** Display names for Discord user ids, for the Console's mapping table. Unknown users come back as null. */
  async memberNames(guildId: string, ids: string[]) {
    const guild = this.client.guilds.cache.get(guildId);
    const out: Record<string, string | null> = {};
    await Promise.all(
      ids.map(async (id) => {
        const cached = guild?.members.cache.get(id);
        const member = cached ?? (guild ? await guild.members.fetch(id).catch(() => null) : null);
        out[id] = member?.displayName ?? null;
      }),
    );
    return out;
  }
}
