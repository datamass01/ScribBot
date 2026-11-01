import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { SessionRow, Store } from "./db.js";
import { bus } from "./events.js";
import { sessionPaths } from "./paths.js";

/**
 * Story write-ups from the summarize-session skill (.claude/skills/summarize-session), saved as
 * data/sessions/<id>/story/summary.story.md. A story stitched from several sessions lives in one
 * of their folders (prepare.py --out can put it anywhere under data/sessions); its lines.json
 * lists every session it covers, so any of them finds it.
 */

export interface StoryFile {
  /** The session whose folder holds the story; the Foundry journal is keyed on it. */
  sessionId: string;
  sessionNumber: number;
  /** Every session the story covers, in order (two when an interrupted game was stitched). */
  sessionNumbers: number[];
  startedAt: string;
  title: string;
  markdown: string;
  /** Image files the story shows (`![alt](banner.png)`) that exist next to it; served by GET …/story/assets/:name. */
  assets: string[];
}

const STORY_FILE = "summary.story.md";
/** Images a story may embed: plain file names next to summary.story.md, nothing else. */
const ASSET_NAME = /^[\w][\w .()-]{0,120}\.(png|jpe?g|webp|gif)$/i;
const ASSET_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Image references in a story's Markdown that are safe asset names. */
export function storyImageRefs(markdown: string): string[] {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const refs = [...markdown.matchAll(/!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?\s*\)/g)].map((m) => decode(m[1]!));
  return [...new Set(refs.filter((r) => ASSET_NAME.test(r)))];
}

export const storyPath = (sessionId: string) => path.join(sessionPaths(sessionId).dir, "story", STORY_FILE);

/** Session ids a story folder covers, from the lines.json prepare.py writes next to it. */
function coveredSessions(storyDir: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(storyDir, "lines.json"), "utf8")) as { sessions?: { id?: unknown }[] };
    return (data.sessions ?? []).map((s) => s.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** The story file for a session: its own folder's, else one whose lines.json covers it. */
export function findStoryFile(sessionId: string): { file: string; folderId: string; covers: string[] } | null {
  const own = storyPath(sessionId);
  if (fs.existsSync(own)) {
    const covers = coveredSessions(path.dirname(own));
    return { file: own, folderId: sessionId, covers: covers.length ? covers : [sessionId] };
  }
  let dirs: string[];
  try {
    dirs = fs.readdirSync(config.sessionsDir);
  } catch {
    return null;
  }
  for (const folderId of dirs) {
    const file = storyPath(folderId);
    if (!fs.existsSync(file)) continue;
    const covers = coveredSessions(path.dirname(file));
    if (covers.includes(sessionId)) return { file, folderId, covers };
  }
  return null;
}

/** Why a story can't be imported yet, or null. A template note ("<One paragraph…>") means it isn't written. */
export function storyProblem(markdown: string): string | null {
  if (!/^##\s+/m.test(markdown)) return "the story has no sections";
  if (/^<[^>\n]/m.test(markdown)) return "the story still has template notes (<…>); finish it and run verify.py";
  return null;
}

export function loadStory(store: Store, session: SessionRow): StoryFile {
  const found = findStoryFile(session.id);
  if (!found) throw new Error(`Session ${session.number} has no story. Write one with the summarize-session skill first.`);
  const markdown = fs.readFileSync(found.file, "utf8");
  const problem = storyProblem(markdown);
  if (problem) throw new Error(`Session ${session.number}'s story isn't ready: ${problem}.`);
  const sessions = found.covers.map((id) => store.getSession(id)).filter((s): s is SessionRow => Boolean(s));
  const holder = store.getSession(found.folderId) ?? session;
  const numbers = (sessions.length ? sessions : [holder]).map((s) => s.number).sort((a, b) => a - b);
  const first = (sessions.length ? sessions : [holder]).reduce((a, b) => (a.started_at <= b.started_at ? a : b));
  const dir = path.dirname(found.file);
  return {
    sessionId: holder.id,
    sessionNumber: numbers[0]!,
    sessionNumbers: numbers,
    startedAt: first.started_at,
    title: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? `Session ${numbers[0]}`,
    markdown,
    assets: storyImageRefs(markdown).filter((name) => fs.existsSync(path.join(dir, name))),
  };
}

/** An image next to a session's story, or null. Only names the story itself references are served. */
export function storyAsset(sessionId: string, name: string): { file: string; type: string } | null {
  if (!ASSET_NAME.test(name)) return null;
  const found = findStoryFile(sessionId);
  if (!found) return null;
  if (!storyImageRefs(fs.readFileSync(found.file, "utf8")).includes(name)) return null;
  const file = path.join(path.dirname(found.file), name);
  if (path.dirname(file) !== path.dirname(found.file) || !fs.existsSync(file)) return null;
  return { file, type: ASSET_TYPES[name.split(".").pop()!.toLowerCase()]! };
}

/** Asks the Foundry bridge to import a session's story as a journal entry. Throws if it isn't ready. */
export function announceStory(store: Store, session: SessionRow): StoryFile {
  const story = loadStory(store, session);
  console.log(`[story] asking Foundry to import "${story.title}" (session ${story.sessionNumbers.join(" + ")})`);
  bus.emitEvent({ type: "story.ready", sessionId: story.sessionId, number: story.sessionNumber, title: story.title });
  return story;
}
