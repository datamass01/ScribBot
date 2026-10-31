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
} from "discord.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { config } from "./config.js";
import type { SessionRow, Store } from "./db.js";
import { bus } from "./events.js";
import { resolveParticipant, speakerLabel } from "./participants.js";
import { sessionPaths } from "./paths.js";
import { isProcessing, makeLiveTranscriber, processSession } from "./pipeline.js";
import { SessionRecorder } from "./recorder.js";
import type { SummaryFile } from "./summarize/schema.js";
import { workerHealth } from "./worker-client.js";

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

    const recorder = new SessionRecorder(id, voice, async (userId) => {
      const member = await i.guild.members.fetch(userId).catch(() => null);
      if (!member || member.user.bot) return null;
      return resolveParticipant(
        userId,
        member.displayName,
        this.store.getMappings(i.guildId),
        this.store.getRoster(),
      );
    }, makeLiveTranscriber(sessionPaths(id).dir));
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
      `🔴 **Recording session ${session.number}** in ${voice}.\n` +
        `Everyone in this channel is being recorded so ScribBot can transcribe the session and write a summary. ` +
        (config.deleteAudioAfterTranscribe
          ? `Speech is transcribed on the host's machine as you talk and the audio is deleted right after; `
          : `Audio stays on the host's machine; `) +
        `the transcript is sent to an AI service (${config.llm.provider}) to write the summary. ` +
        `If you do not want to be recorded, leave the channel and let the GM know.\n\n${mapped}${workerNote}`,
    );
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

  private runPipeline(sessionId: string, channelId: string | null, opts: { retranscribe?: boolean } = {}) {
    void processSession(this.store, sessionId, {
      ...opts,
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
      await i.reply(`✅ ${user} → **${r.actor_name ?? "GM"}** (Foundry user ${r.user_name})`);
    } else {
      this.store.upsertMapping({ guildId: i.guildId, discordId: user.id, foundryUserId: null, actorId: null, characterName: value });
      await i.reply(`✅ ${user} → **${value}** (not linked to a Foundry actor)`);
    }
  }

  private async unmap(i: ChatInputCommandInteraction<"cached">) {
    const user = i.options.getUser("user", true);
    this.assertCanEdit(i, user.id);
    this.store.deleteMapping(i.guildId, user.id);
    await i.reply({ content: `Removed mapping for ${user}.`, flags: MessageFlags.Ephemeral });
  }

  private async gm(i: ChatInputCommandInteraction<"cached">) {
    const user = i.options.getUser("user", true);
    this.assertCanEdit(i, user.id);
    const isGm = i.options.getBoolean("is_gm") ?? true;
    this.store.upsertMapping({ guildId: i.guildId, discordId: user.id, isGm });
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
    const session = ref ? this.store.findSession(i.guildId, ref) : this.store.latestSession(i.guildId);
    if (!session) throw new Error("No such session.");
    if (session.status === "recording") throw new Error("That session is still recording.");
    if (isProcessing(session.id)) throw new Error("That session is already being processed.");
    const paths = sessionPaths(session.id);
    if (summaryOnly && !fs.existsSync(paths.transcriptJson)) {
      throw new Error("That session has no transcript yet; use `/scrib process` instead.");
    }
    const retranscribe = !summaryOnly && (i.options.getBoolean("retranscribe") ?? false);
    if (retranscribe && session.audio_purged) throw new Error("Audio for that session was already deleted.");

    await i.reply(`🔄 Processing session ${session.number}${retranscribe ? " (re-transcribing)" : ""}…`);
    this.runPipeline(session.id, i.channelId, { retranscribe });
  }
}
