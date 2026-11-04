import { createHash } from "node:crypto";
import fs from "node:fs";
import { config } from "./config.js";
import type { SessionRow, Store } from "./db.js";
import { bus } from "./events.js";
import { writeFileAtomic } from "./fsutil.js";
import { sessionPaths } from "./paths.js";
import { findStoryFile, loadStory, storyProblem, storySessionIds, type StoryFile } from "./story.js";
import { parseTime } from "./summarize/format.js";
import { verifyQuotes } from "./summarize/quotes.js";
import { SummarySchema, type SummaryFile } from "./summarize/schema.js";
import { readSummaryFile, sessionQuoteSources, writeSummaryFile } from "./summarize/summarize.js";

/**
 * Review before Foundry (docs/design.md §8.2). With REVIEW_BEFORE_FOUNDRY on, a summary or story is
 * sent to Foundry only once someone has approved it. An approval is of one exact content: the
 * store keeps a hash of the file approved, so a new summary, an LLM revision or an edit (in the
 * Console or on disk) needs approving again. The bot never serves unapproved content to Foundry.
 */

export type ReviewKind = "summary" | "story";

/** Hashes by path, size and mtime: listing sessions every few seconds mustn't re-read every file. */
const hashes = new Map<string, { stamp: string; hash: string }>();

export function fileHash(file: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const memo = hashes.get(file);
  if (memo?.stamp === stamp) return memo.hash;
  const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 32);
  hashes.set(file, { stamp, hash });
  return hash;
}

/** The file under review, and the session whose row holds its approval (a stitched story's holder). */
function target(session: SessionRow, kind: ReviewKind): { file: string; holderId: string } | null {
  if (kind === "summary") {
    const file = sessionPaths(session.id).summary;
    return fs.existsSync(file) ? { file, holderId: session.id } : null;
  }
  const found = findStoryFile(session.id);
  return found ? { file: found.file, holderId: found.folderId } : null;
}

export interface ReviewState {
  /** REVIEW_BEFORE_FOUNDRY: Foundry gets it only once approved. */
  required: boolean;
  /** This exact content was approved. */
  approved: boolean;
  approvedAt: string | null;
  /** Approved once, but changed since (needs approving again). */
  changedSinceApproval: boolean;
  /** Identifies the content reviewed; an approval or an edit must name it, so nobody approves what they haven't seen. */
  hash: string;
}

/** Where a session's summary or story stands in review, or null when there is none. */
export function reviewState(store: Store, session: SessionRow, kind: ReviewKind): ReviewState | null {
  const t = target(session, kind);
  const hash = t && fileHash(t.file);
  if (!t || !hash) return null;
  // Read again: the row passed in may be from before an approval.
  const holder = store.getSession(t.holderId) ?? session;
  const approvedHash = holder[`${kind}_approved_hash`];
  const approved = approvedHash === hash;
  return {
    required: config.reviewBeforeFoundry,
    approved,
    approvedAt: approved ? holder[`${kind}_approved_at`] : null,
    changedSinceApproval: Boolean(approvedHash) && !approved,
    hash,
  };
}

/** May Foundry have it now? Not when review is on and this content isn't approved. */
export function foundryMayHave(store: Store, session: SessionRow, kind: ReviewKind) {
  const r = reviewState(store, session, kind);
  return Boolean(r) && (!r!.required || r!.approved);
}

/** Why it can't go to Foundry yet, or null. */
export function reviewBlocker(store: Store, session: SessionRow, kind: ReviewKind): string | null {
  const r = reviewState(store, session, kind);
  if (!r || !r.required || r.approved) return null;
  const command = kind === "summary" ? `/scrib approve session:${session.number}` : `/scrib approve session:${session.number} what:story`;
  return (
    `Session ${session.number}'s ${kind} ${r.changedSinceApproval ? "changed since it was approved" : "hasn't been reviewed yet"}. ` +
    `Review and approve it first: the Console's Sessions tab (Review), or \`${command}\` in Discord.`
  );
}

/** Thrown when the content changed since the reviewer loaded it: nobody approves what they haven't seen. */
export class StaleReviewError extends Error {}

/** Approve the summary or story as it is now. `hash`, when given, must be what the reviewer saw. */
export function approve(store: Store, session: SessionRow, kind: ReviewKind, hash?: string) {
  const t = target(session, kind);
  const now = t && fileHash(t.file);
  if (!t || !now) throw new Error(`Session ${session.number} has no ${kind} to approve.`);
  if (hash && hash !== now) throw new StaleReviewError(`Session ${session.number}'s ${kind} changed since you opened it. Look it over again.`);
  if (kind === "story") {
    const problem = storyProblem(fs.readFileSync(t.file, "utf8"));
    if (problem) throw new Error(`Session ${session.number}'s story isn't ready: ${problem}.`);
  }
  store.markApproved(t.holderId, kind, now);
  console.log(`[review] session ${session.number}: ${kind} approved for Foundry`);
  return now;
}

/** Asks the Foundry bridge to import the summary (`manual`: someone asked, so auto-import off doesn't stop it). Throws if review blocks it. */
export function announceSummary(store: Store, session: SessionRow, opts: { manual?: boolean } = {}) {
  const file = sessionPaths(session.id).summary;
  if (!fs.existsSync(file)) throw new Error(`Session ${session.number} has no summary yet. Summarize it first.`);
  const blocked = reviewBlocker(store, session, "summary");
  if (blocked) throw new Error(blocked);
  const { summary } = readSummaryFile(session.id);
  console.log(`[review] asking Foundry to import the summary of session ${session.number}`);
  bus.emitEvent({ type: "summary.ready", sessionId: session.id, number: session.number, title: summary.title, ...(opts.manual ? { manual: true } : {}) });
  store.markSent(session.id, "summary");
  return summary;
}

function checkUnchanged(session: SessionRow, kind: ReviewKind, file: string, baseHash: string | undefined) {
  if (baseHash && fileHash(file) !== baseHash) {
    throw new StaleReviewError(
      `Session ${session.number}'s ${kind} changed since you opened it (a new summary or an LLM revision finished). Reload it; your edits weren't saved.`,
    );
  }
}

/**
 * Saves a reviewer's corrections to the summary. Keeps the bookkeeping; each quote's time comes
 * from its timestamp and it is checked against the transcript again, but kept either way (the
 * reviewer's call, shown as unverified). Needs approving again afterwards.
 */
export function saveSummaryEdit(store: Store, session: SessionRow, edited: unknown, baseHash?: string): SummaryFile {
  const p = sessionPaths(session.id);
  if (!fs.existsSync(p.summary)) throw new Error(`Session ${session.number} has no summary to edit.`);
  checkUnchanged(session, "summary", p.summary, baseHash);
  const summary = SummarySchema.parse(edited);
  const current = readSummaryFile(session.id);
  let sources: ReturnType<typeof sessionQuoteSources>["sources"] = [];
  try {
    sources = sessionQuoteSources(store, session.id).sources;
  } catch {
    // no transcript any more: quotes are kept, unverified
  }
  const quotes = summary.quotes.map((q) => {
    const { kept } = verifyQuotes([q], sources);
    return kept[0] ?? { ...q, seconds: parseTime(q.t) ?? 0, verified: false };
  });
  const file: SummaryFile = {
    ...current,
    summary: { ...summary, quotes: quotes.sort((a, b) => a.seconds - b.seconds) },
    editedAt: new Date().toISOString(),
  };
  writeSummaryFile(session.id, file);
  console.log(`[review] session ${session.number}: summary edited in review`);
  return file;
}

/** Saves a reviewer's corrections to the story's Markdown (summary.story.md). */
export function saveStoryEdit(store: Store, session: SessionRow, markdown: string, baseHash?: string): StoryFile {
  const found = findStoryFile(session.id);
  if (!found) throw new Error(`Session ${session.number} has no story to edit.`);
  checkUnchanged(session, "story", found.file, baseHash);
  if (!markdown.trim()) throw new Error("The story can't be empty.");
  const problem = storyProblem(markdown);
  if (problem) throw new Error(`Not saved: ${problem}.`);
  writeFileAtomic(found.file, markdown.replace(/\r\n?/g, "\n"));
  console.log(`[review] session ${session.number}: story edited in review`);
  return loadStory(store, session);
}

/** Asks the Foundry bridge to import a session's story as a journal entry. Throws if it isn't ready, or review blocks it. */
export function announceStory(store: Store, session: SessionRow): StoryFile {
  const story = loadStory(store, session);
  const blocked = reviewBlocker(store, session, "story");
  if (blocked) throw new Error(blocked);
  console.log(`[story] asking Foundry to import "${story.title}" (session ${story.sessionNumbers.join(" + ")})`);
  bus.emitEvent({ type: "story.ready", sessionId: story.sessionId, number: story.sessionNumber, title: story.title });
  for (const id of storySessionIds(store, session)) store.markSent(id, "story");
  return story;
}
