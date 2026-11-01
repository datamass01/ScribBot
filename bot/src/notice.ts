/** The consent notice posted on `/scrib start`. */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for loopback and private-network addresses (10/8, 172.16/12, 192.168/16, *.local). */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(h) || h.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Whether summaries are written by a model on the host's own machine or local network. */
export function isLocalSummarizer(llm: { provider: string; openaiBaseUrl?: string }): boolean {
  if (llm.provider !== "openai-compatible" || !llm.openaiBaseUrl) return false;
  try {
    return isLocalHost(new URL(llm.openaiBaseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The wording is the group's own. When sessions are summarized automatically by an outside
 * service, one sentence says so, because the notice must not claim everything stays local
 * when the transcript is in fact sent elsewhere. With AUTO_SUMMARIZE off nothing is sent
 * unless someone runs /scrib summarize, so the notice stays as written.
 */
export function recordingNotice(p: {
  sessionNumber: number;
  channel: string;
  llm: { provider: string; openaiBaseUrl?: string };
  autoSummarize: boolean;
}): string {
  const remote =
    p.autoSummarize && !isLocalSummarizer(p.llm)
      ? `The summary is written by an online AI service (${p.llm.provider}), so the transcript is sent to it. `
      : "";
  return (
    `🔴 **Recording session ${p.sessionNumber}** in ${p.channel}.\n` +
    `This game session is being transcribed by ScribBot using the Whistle AI model, a locally hosted LLM. ` +
    `Transcript is saved to host's machine as you talk. ` +
    `This transcript will be converted to a game summary and posted to FoundryVTT. ` +
    remote +
    `If you do not want to participate, leave the channel and let the GM know.`
  );
}
