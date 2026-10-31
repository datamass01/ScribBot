import { generateDependencyReport } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { startApi } from "./api/server.js";
import { CommandHandler } from "./commands.js";
import { config, requireDiscordConfig } from "./config.js";
import { Store } from "./db.js";
import { installLogCapture } from "./monitor.js";
import { purgeExpiredAudio } from "./pipeline.js";

installLogCapture();
const { token } = requireDiscordConfig();
const store = new Store();

// Anything left mid-flight by a crash or restart can be resumed with /scrib process.
for (const s of store.listSessions(1000)) {
  if (s.status === "recording" || s.status === "transcribing" || s.status === "summarizing") {
    store.setSessionStatus(s.id, "failed", `Interrupted while ${s.status} (bot restarted). Run /scrib process to resume.`);
  }
}

if (process.env.SCRIBBOT_DEBUG_VOICE) console.log(generateDependencyReport());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const commands = new CommandHandler(client, store);

client.once(Events.ClientReady, (c) => {
  console.log(`[discord] logged in as ${c.user.tag}`);
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

const shutdown = () => {
  console.log("[scribbot] shutting down");
  client.destroy().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
