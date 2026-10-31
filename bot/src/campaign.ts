import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { foundryActorsFile } from "./paths.js";

/** Read a campaign file, dropping <!-- comments --> (template instructions). */
const readIfExists = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";

/**
 * Campaign knowledge from campaign/context.md (lore, recent events) and
 * campaign/glossary.md (names, one per line or "- Name: note"), plus actor
 * names synced from Foundry.
 */
export function loadCampaign() {
  const context = readIfExists(path.join(config.campaignDir, "context.md"));
  const glossaryFile = readIfExists(path.join(config.campaignDir, "glossary.md"));
  const actorNames = loadActorNames();
  const glossary = actorNames.length
    ? `${glossaryFile}\n\nActors in the Foundry world: ${actorNames.join(", ")}`
    : glossaryFile;
  return { context, glossary, glossaryFile, actorNames };
}

function loadActorNames(): string[] {
  const file = foundryActorsFile();
  if (!fs.existsSync(file)) return [];
  try {
    const actors = JSON.parse(fs.readFileSync(file, "utf8")) as { name: string }[];
    return [...new Set(actors.map((a) => a.name))].slice(0, 300);
  } catch {
    return []; // a corrupt cache is rewritten on the next roster sync
  }
}

/** The names in a glossary: each list item or line, up to any ":" note. */
export function glossaryNames(glossary: string) {
  return glossary
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("#"))
    .map((l) => l.replace(/^\s*[-*]\s*/, "").split(":")[0]!.trim())
    .filter((n) => n && n.length <= 40);
}

/** Proper nouns for Whistle's keyword biasing, so it spells fantasy names right. */
export function sttKeywords(extraNames: string[]) {
  const { glossaryFile, actorNames } = loadCampaign();
  // Party and glossary first: if the list is long, those matter most.
  return [...new Set([...extraNames, ...glossaryNames(glossaryFile), ...actorNames])].slice(0, 150);
}
