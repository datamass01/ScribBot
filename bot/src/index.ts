import { generateDependencyReport } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { startApi } from "./api/server.js";
import { CommandHandler } from "./commands.js";
import { config, requireDiscordConfig } from "./config.js";
import { Store } from "./db.js";
import { bus } from "./events.js";
import { DailyLog } from "./logfile.js";
import { installLogCapture, writeLogFile } from "./monitor.js";
import { sessionPaths } from "./paths.js";
import { purgeExpiredAudio } from "./pipeline.js";
import { planRestart } from "./recovery.js";

installLogCapture(config.logRetentionDays > 0 ? new DailyLog(config.logDir, config.logRetentionDays) : undefined);
const { token } = requireDiscordConfig();
const store = new Store();

// ---------- process-level safety nets (docs/assessment/02 S1, S9) ----------

let exitReason = "unknown";
process.on("exit", (code) => writeLogFile("info", `[scribbot] exit code ${code} (${exitReason})`));
process.on("unhandledRejection", (reason) => {
  // Logged, not fatal: one failed promise must not end a recording.
  console.error("[scribbot] unhandled promise rejection:", reason instanceof Error ? reason.stack : reason);
});

// ---------- sessions the last process left mid-flight (02 S3, S8) ----------

const plan = planRestart(store.listSessions(1000), {
  now: Date.now(),
  resumeWindowMs: config.resumeWindowMinutes * 60_000,
  paths: sessionPaths,
});
for (const s of plan.interrupted) {
  const error =
    s.status === "recording"
      ? `Interrupted while recording (bot restarted). Run /scrib process session:${s.number} to transcribe what was recorded.`
      : `Interrupted while ${s.status} (bot restarted). Run /scrib process session:${s.number} to resume.`;
  store.setSessionStatus(s.id, "failed", error);
}
if (plan.resume.length) console.log(`[scribbot] will try to resume recording session(s) ${plan.resume.map((s) => s.number).join(", ")}`);

if (process.env.SCRIBBOT_DEBUG_VOICE) console.log(generateDependencyReport());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const commands = new CommandHandler(client, store);

// An `error` with no listener is thrown and ends the process (02 S2); discord.js reconnects by itself.
client.on(Events.Error, (err) => console.error("[discord] client error:", err));
client.on(Events.ShardError, (err, shard) => console.error(`[discord] shard ${shard} error:`, err));
client.on(Events.Warn, (msg) => console.warn(`[discord] ${msg}`));
client.on(Events.ShardDisconnect, (ev, shard) => console.warn(`[discord] shard ${shard} disconnected (${ev.code})`));
client.on(Events.ShardReconnecting, (shard) => console.log(`[discord] shard ${shard} reconnecting`));

let recovered = false;
client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
  if (recovered) return;
  recovered = true;
  void (async () => {
    await commands.resumeInterrupted(plan.resume);
    await commands.announceInterrupted(plan.interrupted);
    commands.resumeProcessing(plan.process);
  })().catch((err) => console.error("[scribbot] restart recovery failed:", err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "scrib") {
    await commands.handle(interaction);
  } else if (interaction.isAutocomplete() && interaction.commandName === "scrib") {
    await commands.autocomplete(interaction).catch((err) => console.error("[discord] autocomplete failed:", err));
  }
});

await startApi(store, () => commands.currentRecording(), {
  discord: () => ({
    ready: client.isReady(),
    tag: client.user?.tag ?? null,
    pingMs: client.isReady() && client.ws.ping >= 0 ? client.ws.ping : null,
    guilds: client.guilds.cache.size,
    readySince: client.readyAt?.toISOString() ?? null,
  }),
  recordings: () => commands.activeRecordings(),
});
await client.login(token);

purgeExpiredAudio(store, config.audioRetentionDays);
setInterval(() => purgeExpiredAudio(store, config.audioRetentionDays), 6 * 3600_000).unref();
setInterval(() => void commands.checkBacklog(config.backlogWarnMinutes), 60_000).unref();

// ---------- shutdown (02 S8) ----------

let shuttingDown = false;
async function shutdown(reason: string, code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitReason = reason;
  console.log(`[scribbot] shutting down (${reason})`);
  // Finalize open clips and timeline.json so the session can be processed on the next start.
  const hardStop = setTimeout(() => process.exit(code || 1), 20_000);
  hardStop.unref();
  try {
    await commands.stopAll(10_000);
  } catch (err) {
    console.error("[scribbot] stopping recordings failed:", err);
  }
  bus.removeAllListeners();
  await client.destroy().catch(() => {});
  process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGBREAK", () => void shutdown("SIGBREAK", 0)); // Ctrl+Break / closing the console on Windows
process.on("uncaughtException", (err) => {
  // State is unknown now: save the recordings, then exit non-zero so the supervisor restarts us.
  console.error("[scribbot] uncaught exception:", err?.stack ?? err);
  void shutdown(`uncaught exception: ${err?.message ?? err}`, 1);
});
