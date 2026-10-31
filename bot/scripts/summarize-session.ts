/**
 * Re-run the pipeline for a session from the command line, without Discord:
 *   npm run summarize -- <session-id|latest> [--retranscribe] [--transcribe-only]
 */
import { Store } from "../src/db.js";
import { processSession } from "../src/pipeline.js";

const args = process.argv.slice(2);
const ref = args.find((a) => !a.startsWith("--")) ?? "latest";
const store = new Store();
const session = ref === "latest" ? store.latestSession() : store.getSession(ref);
if (!session) {
  console.error(`No session "${ref}". Known sessions:`);
  for (const s of store.listSessions()) console.error(`  ${s.id}  #${s.number}  ${s.status}`);
  process.exit(1);
}

const file = await processSession(store, session.id, {
  retranscribe: args.includes("--retranscribe"),
  skipSummary: args.includes("--transcribe-only"),
  notify: (text) => console.log(text),
});
if (file) console.log(`\nDone: "${file.summary.title}". See data/sessions/${session.id}/summary.md`);
