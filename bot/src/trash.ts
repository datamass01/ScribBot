import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { SessionRow, Store } from "./db.js";
import { renameWithRetry } from "./fsutil.js";
import { mergedInto } from "./merge.js";
import { sessionPaths, sessionRecordings } from "./paths.js";
import { isProcessing } from "./pipeline.js";

/**
 * Soft delete for the Console (docs/console-design.md §4.3): a session's folder moves to
 * DATA_DIR/trash/<id> and the row keeps `deleted_at`, so session numbers are never reused.
 * Every function throws an Error whose message can be shown to the user as is.
 */

export const trashFolder = (sessionId: string) => path.join(config.trashDir, sessionId);

export function deleteSession(store: Store, session: SessionRow, isRecording: (id: string) => boolean) {
  if (session.deleted_at) throw new Error(`Session ${session.number} is already in the trash.`);
  if (session.merged_into_id) throw new Error(`Session ${session.number} was merged into another session; delete that one instead.`);
  if (session.status === "recording" || isRecording(session.id)) throw new Error(`Session ${session.number} is recording. Stop it first.`);
  if (isProcessing(session.id)) throw new Error(`Session ${session.number} is being processed. Wait for it to finish.`);
  const from = sessionPaths(session.id).dir;
  const to = trashFolder(session.id);
  if (fs.existsSync(to)) throw new Error(`The trash already has a folder for session ${session.number} (${to}).`);
  if (fs.existsSync(from)) {
    fs.mkdirSync(config.trashDir, { recursive: true });
    try {
      renameWithRetry(from, to);
    } catch (err) {
      throw new Error(
        `Couldn't move session ${session.number}'s folder to the trash (${(err as Error).message}). ` +
          "Something may have a file in it open, such as the worker or an editor.",
      );
    }
  }
  // The game's folder holds all its recordings: they go to the trash together.
  for (const rid of sessionRecordings(session.id)) store.markDeleted(rid, true);
  console.log(`[trash] session ${session.number} (${session.id}) moved to the trash`);
}

export function restoreSession(store: Store, session: SessionRow) {
  if (!session.deleted_at) throw new Error(`Session ${session.number} isn't in the trash.`);
  if (session.purged_at) throw new Error(`Session ${session.number} was deleted permanently.`);
  const from = trashFolder(session.id);
  const to = sessionPaths(session.id).dir;
  if (fs.existsSync(to)) throw new Error(`A folder for session ${session.number} already exists (${to}).`);
  if (fs.existsSync(from)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    renameWithRetry(from, to);
  }
  for (const rid of sessionRecordings(session.id)) store.markDeleted(rid, false);
  console.log(`[trash] session ${session.number} (${session.id}) restored`);
}

export function purgeSession(store: Store, session: SessionRow) {
  if (!session.deleted_at) throw new Error(`Session ${session.number} isn't in the trash. Delete it first.`);
  fs.rmSync(trashFolder(session.id), { recursive: true, force: true });
  if (!session.purged_at) for (const rid of sessionRecordings(session.id)) store.markPurged(rid);
  console.log(`[trash] session ${session.number} (${session.id}) deleted permanently`);
}

/** TRASH_RETENTION_DAYS: empty trash older than that (0 = never). Logs and carries on per session. */
export function purgeExpiredTrash(store: Store, days: number, log: (msg: string) => void = console.log) {
  if (days <= 0) return;
  for (const s of store.trashOlderThan(new Date(Date.now() - days * 86_400_000))) {
    try {
      purgeSession(store, s);
    } catch (err) {
      log(`[trash] couldn't empty session ${s.number} from the trash: ${(err as Error).message}`);
    }
  }
}

/** Why a session can't be used by the pipeline, merges or imports, or null. */
export function unusableReason(session: SessionRow): string | null {
  if (session.deleted_at) return `Session ${session.number} is in the trash. Restore it first.`;
  const into = mergedInto(session);
  if (into != null) return `Session ${session.number} was merged into session ${into}; use that one instead.`;
  return null;
}
