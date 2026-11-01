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
import { llmConfigProblem } from "./api/status.js";
import { config } from "./config.js";
import type { SessionRow, Store } from "./db.js";
import { bus } from "./events.js";
import { resolveParticipant, speakerLabel } from "./participants.js";
import { recordingNotice } from "./notice.js";
import { foundryActorsFile, sessionPaths } from "./paths.js";
import { linksToWrite, unlink, type RosterLink } from "./links.js";
import { formatGap, mergeSessions, mergedInto } from "./merge.js";
import { isProcessing, makeLiveTranscriber, processSession } from "./pipeline.js";
import { SessionRecorder, type RecorderOptions } from "./recorder.js";
import { SHUTDOWN_NOTE, defaultSessionToProcess, lastActivityMs } from "./recovery.js";
import { readTimeline } from "./timeline.js";
import type { SummaryFile } from "./summarize/schema.js";
import { backlogMinutes, workerHealth } from "./worker-client.js";
import { announceStory, findStoryFile } from "./story.js";

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
      .setName("merge")
      .setDescription("Merge an interrupted game's continuation session into the one it continues")
      .addStringOption((o) => o.setName("a").setDescription("Session number to keep (the first part)").setRequired(true))
      .addStringOption((o) => o.setName("b").setDescription("Session number to merge in (the continuation)").setRequired(true)),
  );

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
    const me = i.guild.members.me!;
    const perms = voice.permissionsFor(me);
    if (!perms.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.ViewChannel)) {
      await i.reply({ content: `I need **View Channel** and **Connect** in ${voice}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();

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
      guildId: i.guildId,
      channelId: voice.id,
      textChannelId: i.channelId,
      startedAt,
    });

    // Seed the session's copy of the character and NPC details with the last roster sync;
    // Foundry replaces it with fresh ones when it hears "session.started" (and again at stop).
    try {
      if (fs.existsSync(foundryActorsFile())) {
        fs.mkdirSync(sessionPaths(id).dir, { recursive: true });
        fs.copyFileSync(foundryActorsFile(), sessionPaths(id).actors);
      }
    } catch (err) {
      console.warn(`[commands] could not copy Foundry actor details into session ${id}: ${err}`);
    }

    const recorder = this.makeRecorder(id, voice, i.channelId);
    try {
      await recorder.start();
    } catch (err) {
      this.store.setSessionStatus(id, "failed", `Could not join voice: ${err}`);
      throw new Error(`Could not connect to ${voice.name}: ${err instanceof Error ? err.message : err}`);
    }
    this.recordings.set(i.guildId, { recorder, session, textChannelId: i.channelId });
    bus.emitEvent({ type: "session.started", sessionId: id, number: session.number, startedAt });

    const mapped = this.describeVoiceMembers(i.guildId, voice.members.filter((m) => !m.user.bot).values());
    await i.editReply(
      `${recordingNotice({ sessionNumber: session.number, channel: String(voice), llm: config.llm, autoSummarize: config.autoSummarize })}\n\n${mapped}${workerNote}`,
    );
  }

  private makeRecorder(sessionId: string, voice: VoiceBasedChannel, textChannelId: string | null, resume?: RecorderOptions["resume"]) {
    const number = () => this.store.getSession(sessionId)?.number ?? "?";
    return new SessionRecorder(
      sessionId,
      voice,
      async (userId) => {
        const member = await voice.guild.members.fetch(userId).catch(() => null);
        if (!member || member.user.bot) return null;
        return resolveParticipant(userId, member.displayName, this.store.getMappings(voice.guild.id), this.store.getRoster());
      },
      {
        onSegment: makeLiveTranscriber(sessionPaths(sessionId).dir),
        resume,
        onConnection: (e) => {
          const text =
            e.type === "reconnecting"
              ? `⚠️ Session ${number()}: lost the voice connection. Trying to rejoin ${voice}…`
              : e.type === "restored"
                ? `✅ Session ${number()}: back in ${voice} after ${formatGap(e.gapMs / 1000)}. Recording continues; speech during the gap wasn't recorded.`
                : `❌ Session ${number()}: couldn't rejoin ${voice} after ${e.attempts} tries. I'll keep trying every minute. ` +
                  "`/scrib stop` ends the session and keeps everything recorded so far.";
          void this.send(textChannelId, text).catch((err) => console.error("[commands] notice failed:", err));
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
        await this.send(
          s.text_channel_id,
          `⚠️ ScribBot restarted and couldn't resume recording session ${s.number} (${why}). ` +
            `Everything recorded before the restart is kept: run \`/scrib process session:${s.number}\` to transcribe it, ` +
            "or `/scrib start` to record the rest as a new session (`/scrib merge` can join the two afterwards).",
        ).catch(() => {});
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
        const timeline = readTimeline(paths.dir);
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
        await this.send(
          s.text_channel_id,
          `⚠️ ScribBot restarted; **recording of session ${s.number} resumed** in ${channel} (gap ${gap}). ` +
            "Speech during the gap wasn't recorded.",
        ).catch(() => {});
      } catch (err) {
        await fail(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Tell the table about sessions a restart interrupted that weren't resumed (02 S3, fix 3). */
  async announceInterrupted(sessions: SessionRow[]) {
    for (const s of sessions) {
      await this.send(
        s.text_channel_id,
        `⚠️ ScribBot restarted while session ${s.number} was ${s.status}. ` +
          `Nothing recorded is lost: run \`/scrib process session:${s.number}\` to finish it.`,
      ).catch(() => {});
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
            this.send(
              active.textChannelId,
              `⏹️ ScribBot is shutting down: **session ${session.number} recording stopped and saved** ` +
                `(${timeline.segments.length} clips). It will be transcribed when the bot starts again.`,
            ).catch(() => {}),
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
      await this.send(
        textChannelId,
        `🐢 Transcription is about ${Math.round(minutes)} min behind (${health.queued} clips queued). ` +
          "Nothing is lost: clips wait on disk, but the transcript will take longer after `/scrib stop`.",
      ).catch(() => {});
    }
  }

  private describeVoiceMembers(guildId: string, members: Iterable<GuildMember>) {
    const mappings = this.store.getMappings(guildId);
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
    this.recordings.delete(i.guildId);
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
    await i.editReply(
      `⏹️ **Session ${active.session.number} recording stopped**: ${minutes} min, ` +
        `${timeline.segments.length} clips from ${timeline.participants.length} speaker(s).\n` +
        `Transcribing and summarizing now. I'll post here when it's done.`,
    );
    this.runPipeline(active.session.id, i.channelId);
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
      onSummary: (file) => this.postSummary(channelId, file),
    }).catch(() => {
      // already reported via notify
    });
  }

  private async send(channelId: string | null, payload: string | Parameters<SendableChannels["send"]>[0]) {
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel?.isSendable()) await channel.send(payload);
  }

  private async postSummary(channelId: string | null, f: SummaryFile) {
    const s = f.summary;
    const recap = s.recap.length > 3900 ? `${s.recap.slice(0, 3900)}…` : s.recap;
    const embed = new EmbedBuilder()
      .setTitle(`Session ${f.sessionNumber}: ${s.title}`)
      .setDescription(recap)
      .setColor(0x8b5cf6)
      .setFooter({ text: `Summarized by ${f.model}. Full notes attached and sent to Foundry.` });
    const quotes = s.quotes.slice(0, 3).map((q) => `> "${q.text}"\n> — **${q.character}**`);
    if (quotes.length) embed.addFields({ name: "Quotes", value: quotes.join("\n\n").slice(0, 1024) });
    if (s.hooks.length) embed.addFields({ name: "Open threads", value: s.hooks.map((h) => `• ${h}`).join("\n").slice(0, 1024) });

    const md = sessionPaths(f.sessionId).summaryMd;
    const files = fs.existsSync(md) ? [new AttachmentBuilder(md, { name: `session-${f.sessionNumber}.md` })] : [];
    await this.send(channelId, { embeds: [embed], files });
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

    const previous = this.store.getMappings(i.guildId).find((m) => m.discord_id === user.id);
    if (value.startsWith("foundry:")) {
      const r = this.store.getRoster().find((x) => x.foundry_user_id === value.slice(8));
      if (!r) throw new Error("That Foundry user is no longer in the synced roster.");
      this.store.upsertMapping({
        guildId: i.guildId,
        discordId: user.id,
        foundryUserId: r.foundry_user_id,
        actorId: r.actor_id,
        characterName: r.actor_name,
        isGm: Boolean(r.is_gm),
      });
      const links: RosterLink[] = [];
      if (previous?.foundry_user_id && previous.foundry_user_id !== r.foundry_user_id) links.push(unlink(previous.foundry_user_id, user.id));
      if (r.discord_id !== user.id) links.push({ foundryUserId: r.foundry_user_id, discordId: user.id });
      this.sendLinks(links);
      await i.reply(`✅ ${user} → **${r.actor_name ?? "GM"}** (Foundry user ${r.user_name})`);
    } else {
      this.store.upsertMapping({ guildId: i.guildId, discordId: user.id, foundryUserId: null, actorId: null, characterName: value });
      if (previous?.foundry_user_id) this.sendLinks([unlink(previous.foundry_user_id, user.id)]);
      await i.reply(`✅ ${user} → **${value}** (not linked to a Foundry actor)`);
    }
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
    const previous = this.store.getMappings(i.guildId).find((m) => m.discord_id === user.id);
    this.store.deleteMapping(i.guildId, user.id);
    if (previous?.foundry_user_id) this.sendLinks([unlink(previous.foundry_user_id, user.id)]);
    await i.reply({ content: `Removed mapping for ${user}.`, flags: MessageFlags.Ephemeral });
  }

  private async gm(i: ChatInputCommandInteraction<"cached">) {
    const user = i.options.getUser("user", true);
    this.assertCanEdit(i, user.id);
    const isGm = i.options.getBoolean("is_gm") ?? true;
    this.store.upsertMapping({ guildId: i.guildId, discordId: user.id, isGm });
    if (isGm) this.sendLinks(linksToWrite(this.store.getAllMappings(), this.store.getRoster()));
    await i.reply(isGm ? `🎲 ${user} is the GM.` : `${user} is no longer marked as GM.`);
  }

  private async listMappings(i: ChatInputCommandInteraction<"cached">) {
    const rows = this.store.getMappings(i.guildId).map((m) => {
      const who = m.is_gm ? "GM" : (m.character_name ?? "?");
      return `<@${m.discord_id}> → **${who}**${m.actor_id ? " (Foundry actor linked)" : ""}`;
    });
    const voice = i.member.voice.channel;
    const unmapped =
      voice?.type === ChannelType.GuildVoice || voice?.type === ChannelType.GuildStageVoice
        ? `\n\n${this.describeVoiceMembers(i.guildId, voice.members.filter((m) => !m.user.bot).values())}`
        : "";
    await i.reply({
      content: (rows.join("\n") || "No mappings yet. Use `/scrib map`.") + unmapped,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  // ---------- reprocessing ----------

  private async process(i: ChatInputCommandInteraction<"cached">, summaryOnly: boolean) {
    const ref = i.options.getString("session");
    const session = ref ? this.store.findSession(i.guildId, ref) : defaultSessionToProcess(this.store.listSessions(1000), i.guildId);
    if (!session) throw new Error(ref ? "No such session." : "No finished session to process.");
    const into = mergedInto(session);
    if (into != null) throw new Error(`Session ${session.number} was merged into session ${into}; process that one instead.`);
    if (session.status === "recording") throw new Error("That session is still recording.");
    if (isProcessing(session.id)) throw new Error("That session is already being processed.");
    const paths = sessionPaths(session.id);
    if (summaryOnly && !fs.existsSync(paths.transcriptJson)) {
      throw new Error("That session has no transcript yet; use `/scrib process` instead.");
    }
    const retranscribe = !summaryOnly && (i.options.getBoolean("retranscribe") ?? false);
    if (summaryOnly) {
      // Say why it would fail before anything starts (02 S14).
      const problem = await llmConfigProblem();
      if (problem) throw new Error(problem);
    }
    if (retranscribe && session.audio_purged) throw new Error("Audio for that session was already deleted.");

    await i.reply(`🔄 ${summaryOnly ? "Summarizing" : "Processing"} session ${session.number}${retranscribe ? " (re-transcribing)" : ""}…`);
    // /scrib summarize is the explicit request to send the transcript to the LLM.
    this.runPipeline(session.id, i.channelId, { retranscribe, ...(summaryOnly ? { summarize: true } : {}) });
  }

  private async story(i: ChatInputCommandInteraction<"cached">) {
    const ref = i.options.getString("session");
    const session = ref
      ? this.store.findSession(i.guildId, ref)
      : this.store.listSessions(1000).find((s) => s.guild_id === i.guildId && findStoryFile(s.id) !== null);
    if (!session) throw new Error(ref ? "No such session." : "No session has a story yet. Write one with the summarize-session skill.");
    const story = announceStory(this.store, session);
    await i.reply(
      `📜 Sent **${story.title}** (session ${story.sessionNumbers.join(" + ")}) to Foundry. ` +
        "The bridge client creates the journal entry, or updates it if it's already there.",
    );
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
    const r = mergeSessions(this.store, a.id, b.id, { isBusy: isProcessing });
    console.log(`[merge] session ${b.number} merged into session ${a.number} (${r.linesAdded} lines, gap ${formatGap(r.gapSec)})`);
    bus.emitEvent({ type: "session.status", sessionId: a.id, status: r.target.status, error: r.target.error });
    bus.emitEvent({ type: "session.status", sessionId: b.id, status: r.source.status, error: r.source.error });
    const warnings = r.warnings.map((w) => `\n⚠️ ${w}`).join("");
    await i.reply(
      `🔗 **Session ${b.number} merged into session ${a.number}**: ${r.linesAdded} transcript lines ` +
        `(gap ${formatGap(r.gapSec)}), ${r.chatAdded} chat messages, ${r.combatsAdded} combats` +
        `${r.audioCopied ? `, ${r.audioCopied} audio clips` : ""}. ` +
        `Session ${b.number}'s files are kept; session ${a.number}'s originals are backed up as \`*.premerge-${b.number}\`.` +
        `${warnings}\nRun \`/scrib summarize session:${a.number}\` to summarize the whole game.`,
    );
  }
}
