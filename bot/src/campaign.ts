import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { foundryActorsFile } from "./paths.js";

/** Committed templates; the real files are git-ignored so a campaign is never pushed by accident. */
const CAMPAIGN_FILES = ["context.md", "glossary.md"] as const;

/**
 * Create campaign/context.md and glossary.md from their `.example.md` templates when missing,
 * so there is a local file to edit. Never overwrites. Returns the files it created.
 */
export function ensureCampaignFiles(dir = config.campaignDir): string[] {
  const created: string[] = [];
  for (const name of CAMPAIGN_FILES) {
    const file = path.join(dir, name);
    const template = path.join(dir, name.replace(/\.md$/, ".example.md"));
    if (fs.existsSync(file) || !fs.existsSync(template)) continue;
    try {
      fs.copyFileSync(template, file, fs.constants.COPYFILE_EXCL);
      created.push(file);
    } catch {
      // created meanwhile, or the folder is read-only: the bot works without it
    }
  }
  return created;
}

/** Read a campaign file, dropping <!-- comments --> (template instructions). */
const readIfExists = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";

export type CampaignNote = "context.md" | "glossary.md";

/**
 * Where a campaign's note lives: CAMPAIGN_DIR/<campaign folder>/<name> (the Campaign tab writes
 * it), falling back to the shared CAMPAIGN_DIR/<name> when the campaign has none of its own.
 * The same rule is in the worker (notes_file), the Console and the story skill's prepare.py.
 */
export function campaignNoteFile(name: CampaignNote, folder?: string | null, dir = config.campaignDir) {
  if (folder && isSafeFolder(folder)) {
    const own = path.join(dir, folder, name);
    if (fs.existsSync(own)) return own;
  }
  return path.join(dir, name);
}

const isSafeFolder = (folder: string) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(folder);

/** The campaign folder of a session or recording folder (DATA_DIR/campaigns/<folder>/sessions/…), or null (old flat layout). */
export function campaignFolderOfPath(dir: string) {
  return /(?:^|[\\/])campaigns[\\/]([^\\/]+)[\\/]sessions(?:[\\/]|$)/.exec(dir)?.[1] ?? null;
}

/**
 * Campaign knowledge from context.md (world description, lore, the story so far) and glossary.md
 * (names, one per line or "- Name: note") for a campaign (its folder; none: the shared notes),
 * plus actor names synced from Foundry.
 */
export function loadCampaign(folder?: string | null) {
  const context = readIfExists(campaignNoteFile("context.md", folder));
  const glossaryFile = readIfExists(campaignNoteFile("glossary.md", folder));
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
export function sttKeywords(extraNames: string[], folder?: string | null) {
  const { glossaryFile, actorNames } = loadCampaign(folder);
  // Party and glossary first: if the list is long, those matter most.
  return [...new Set([...extraNames, ...glossaryNames(glossaryFile), ...actorNames])].slice(0, 150);
}
