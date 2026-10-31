import { REST, Routes } from "discord.js";
import { scribCommand } from "../src/commands.js";
import { requireDiscordConfig } from "../src/config.js";

const { token, clientId, guildId } = requireDiscordConfig();
const rest = new REST().setToken(token);
const body = [scribCommand.toJSON()];

if (guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  console.log(`Registered /scrib in guild ${guildId} (available immediately).`);
} else {
  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log("Registered /scrib globally (can take up to an hour to appear).");
}
