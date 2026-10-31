/**
 * Write JSON Schemas for every file contract to shared/schemas/.
 * The zod definitions in src/ are the source of truth; run `npm run schemas` after changing them.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../src/config.js";
import { ChunkNotesSchema, SummarySchema } from "../src/summarize/schema.js";
import { ChatLogSchema, RosterPayloadSchema, TimelineSchema, TranscriptSchema } from "../src/types.js";

const out = path.join(REPO_ROOT, "shared", "schemas");
fs.mkdirSync(out, { recursive: true });

const schemas: Record<string, z.ZodType> = {
  timeline: TimelineSchema,
  transcript: TranscriptSchema,
  chatlog: ChatLogSchema,
  roster: RosterPayloadSchema,
  "chunk-notes": ChunkNotesSchema,
  summary: SummarySchema,
};

for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { io: "input" });
  fs.writeFileSync(path.join(out, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`wrote shared/schemas/${name}.schema.json`);
}
