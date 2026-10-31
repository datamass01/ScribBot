import type { TranscriptLine } from "../types.js";
import { parseTime } from "./format.js";

export interface QuoteCandidate {
  t: string;
  character: string;
  text: string;
  context: string;
}

export interface VerifiedQuote extends QuoteCandidate {
  seconds: number;
  verified: boolean;
}

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Length of the longest common subsequence of two token arrays. */
function lcs(a: string[], b: string[]) {
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length]!;
}

/** Share of the quote's words that appear, in order, in the candidate text. */
export function coverage(quote: string, source: string) {
  const q = tokenize(quote);
  if (!q.length) return 0;
  return lcs(q, tokenize(source)) / q.length;
}

/**
 * Check each quote really appears in the transcript, so the model cannot put
 * invented words in a player's mouth. A quote may span up to three consecutive
 * lines from the same speaker (transcription often splits sentences at pauses).
 */
export function verifyQuotes(
  quotes: QuoteCandidate[],
  lines: TranscriptLine[],
  threshold = 0.8,
): { kept: VerifiedQuote[]; dropped: QuoteCandidate[] } {
  // Pre-build windows of 1-3 consecutive same-speaker lines.
  const windows: { t: number; speaker: string; character: string | null; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    let text = "";
    for (let k = i; k < Math.min(i + 3, lines.length); k++) {
      if (lines[k]!.discordId !== lines[i]!.discordId) break;
      text = text ? `${text} ${lines[k]!.text}` : lines[k]!.text;
      windows.push({ t: lines[i]!.t, speaker: lines[i]!.speaker, character: lines[i]!.character, text });
    }
  }

  const kept: VerifiedQuote[] = [];
  const dropped: QuoteCandidate[] = [];
  for (const q of quotes) {
    let best = { score: 0, t: parseTime(q.t) ?? 0 };
    for (const w of windows) {
      const score = coverage(q.text, w.text);
      if (score > best.score) best = { score, t: w.t };
      if (score === 1) break;
    }
    if (best.score >= threshold) kept.push({ ...q, seconds: best.t, verified: true });
    else dropped.push(q);
  }
  return { kept, dropped };
}
