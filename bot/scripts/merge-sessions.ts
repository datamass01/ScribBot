/**
 * Merge an interrupted game's continuation session into the one it continues, without Discord:
 *   npm run merge -- <A> <B>
 * A and B are session ids or numbers (numbers need a single guild in the database).
 * B's folder is kept; A's files are backed up as *.premerge-<B number> first.
 * Then summarize the merged session: npm run summarize -- <A id>
 */
import { Store, type SessionRow } from "../src/db.js";
import { formatGap, mergeSessions } from "../src/merge.js";

const [refA, refB] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const store = new Store();

function find(ref: string | undefined): SessionRow {
  const all = store.listSessions(100_000);
  const hits = !ref ? [] : /^\d+$/.test(ref) ? all.filter((s) => s.number === Number(ref)) : all.filter((s) => s.id === ref);
  if (hits.length === 1) return hits[0]!;
  console.error(
    !ref
      ? "usage: npm run merge -- <A> <B>   (merge continuation session B into session A)"
      : hits.length
        ? `Session number ${ref} exists in several servers; use the session id.`
        : `No session "${ref}".`,
  );
  console.error("Known sessions:");
  for (const s of all.slice(0, 20)) console.error(`  ${s.id}  #${s.number}  ${s.status}${s.error ? `  (${s.error})` : ""}`);
  process.exit(1);
}

const a = find(refA);
const b = find(refB);
try {
  const r = mergeSessions(store, a.id, b.id);
  console.log(
    `[merge] session ${b.number} merged into session ${a.number}: ${r.linesAdded} lines shifted by ` +
      `${formatGap(r.offsetSec)} (gap ${formatGap(r.gapSec)}), ${r.chatAdded} chat messages, ` +
      `${r.combatsAdded} combats, ${r.audioCopied} clips copied.`,
  );
  for (const f of r.backups) console.log(`[merge] backup: ${f}`);
  for (const w of r.warnings) console.warn(`[merge] warning: ${w}`);
  console.log(`[merge] next: npm run summarize -- ${a.id}`);
} catch (err) {
  console.error(`[merge] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
