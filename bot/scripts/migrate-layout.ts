/**
 * Move sessions from the old flat data/sessions/<id>/ folders to campaign folders
 * (data/campaigns/<world>/sessions/<NNN>/). Shows the plan; --apply does it, after a backup.
 *
 *   npm run migrate-layout             # what would happen
 *   npm run migrate-layout -- --apply  # do it (stop the bot first, or use the Console's button)
 */
import { config } from "../src/config.js";
import { Store } from "../src/db.js";
import { applyLayout, planLayout } from "../src/migrate-layout.js";

const apply = process.argv.includes("--apply");
const store = new Store();
const plan = planLayout(store);

if (!plan.games.length) {
  console.log("[layout] every session already uses the campaign layout; nothing to do.");
  process.exit(0);
}
for (const c of plan.campaigns) console.log(`[layout] campaign ${c.folder}${c.isNew ? " (new)" : ""}${c.worldId ? `, Foundry world ${c.worldId}` : ""}`);
for (const g of plan.games) {
  const where = g.from ? `${g.from} → ${g.inTrash ? `${g.from} (stays in the trash, restructured)` : g.to}` : `(no folder) → ${g.to}`;
  console.log(`[layout] session ${g.oldNumber}${g.number !== g.oldNumber ? ` → ${g.number}` : ""}: ${where}`);
  for (const m of g.merged) console.log(`[layout]   + merged session ${m.number} → recordings/${m.id}`);
  for (const n of g.notes) console.log(`[layout]   note: ${n}`);
}
for (const w of plan.warnings) console.warn(`[layout] warning: ${w}`);
console.log(`[layout] backup first: ${plan.backupDir} (about ${Math.round(plan.backupBytes / 1024 / 1024)} MB)`);

if (!apply) {
  console.log("[layout] dry run: nothing changed. Run with -- --apply to do it.");
  process.exit(0);
}
// The bot moves folders the worker and recorder use; with the bot running, do it from the Console.
const running = await fetch(`http://127.0.0.1:${config.api.port}/health`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
if (running) {
  console.error("[layout] the bot is running. Stop it first, or use the Console (Sessions → Update folder layout), which waits until nothing is recording.");
  process.exit(1);
}
const r = applyLayout(store, plan);
for (const e of r.errors) console.error(`[layout] ${e}`);
console.log(`[layout] done: ${r.moved} of ${plan.games.length} session(s) moved. Backup: ${r.backupDir}`);
process.exit(r.errors.length ? 1 : 0);
