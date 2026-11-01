import fs from "node:fs";
import path from "node:path";
import { SegmentSchema, TimelineSchema, type Segment, type Timeline } from "./types.js";

export const SEGMENT_JOURNAL = "timeline.segments.jsonl";

/** Segments appended to the journal; a torn last line (crash mid-write) is skipped. */
export function readSegmentJournal(file: string): Segment[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Segment[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const seg = SegmentSchema.safeParse(JSON.parse(raw));
      if (seg.success) out.push(seg.data);
    } catch {
      // torn line
    }
  }
  return out;
}

/** Union of the snapshot's segments and the journal's, by file, sorted by start. */
export function mergeSegments(snapshot: Segment[], journal: Segment[]): Segment[] {
  const byFile = new Map<string, Segment>();
  for (const s of snapshot) byFile.set(s.file, s);
  for (const s of journal) if (!byFile.has(s.file)) byFile.set(s.file, s);
  return [...byFile.values()].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Read `timeline.json` from a session folder, adding any clips only the journal lists
 * (the snapshot is written every ~30 s, so a crash can leave it behind the journal).
 */
export function readTimeline(sessionDir: string): Timeline {
  const timeline = TimelineSchema.parse(JSON.parse(fs.readFileSync(path.join(sessionDir, "timeline.json"), "utf8")));
  const journal = readSegmentJournal(path.join(sessionDir, SEGMENT_JOURNAL));
  return journal.length ? { ...timeline, segments: mergeSegments(timeline.segments, journal) } : timeline;
}

/** Append one line and fsync it, so it's on disk before the clip can be handed on (and deleted). */
export function appendLineSync(file: string, line: string) {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
