/**
 * Send a session folder straight to the worker (no Discord, no database):
 *   npx tsx scripts/transcribe-dir.ts <session-dir> [extra names...] [--delete-audio]
 * Audio is kept unless --delete-audio is given.
 */
import { sttKeywords } from "../src/campaign.js";
import { transcribe } from "../src/worker-client.js";

const args = process.argv.slice(2);
const [dir, ...names] = args.filter((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: transcribe-dir.ts <session-dir> [names...] [--delete-audio]");
  process.exit(1);
}
const keywords = sttKeywords(names);
console.log(`keywords: ${keywords.join(", ") || "(none)"}`);
const started = Date.now();
await transcribe(dir, keywords, {
  deleteAudio: args.includes("--delete-audio"),
  onProgress: (f) => console.log(`progress ${Math.round(f * 100)}%`),
});
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
