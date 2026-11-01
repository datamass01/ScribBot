// The /scrib start consent notice: the group's own wording, plus a disclosure only when the
// transcript leaves the host's network for an online summarizer.
import { describe, expect, it } from "vitest";
import { isLocalSummarizer, recordingNotice } from "../src/notice.js";

const WORDING =
  "This game session is being transcribed by ScribBot using the Whistle AI model, a locally hosted LLM. " +
  "Transcript is saved to host's machine as you talk. " +
  "This transcript will be converted to a game summary and posted to FoundryVTT. ";
const CLOSING = "If you do not want to participate, leave the channel and let the GM know.";

describe("recordingNotice", () => {
  it("uses the group's wording as-is with a local summarizer", () => {
    const text = recordingNotice({
      sessionNumber: 5,
      channel: "<#123>",
      llm: { provider: "openai-compatible", openaiBaseUrl: "http://localhost:11434/v1" },
      autoSummarize: true,
    });
    expect(text).toBe(`🔴 **Recording session 5** in <#123>.\n${WORDING}${CLOSING}`);
  });

  it("uses the group's wording as-is when nothing is summarized automatically", () => {
    const text = recordingNotice({ sessionNumber: 7, channel: "<#123>", llm: { provider: "anthropic" }, autoSummarize: false });
    expect(text).toBe(`🔴 **Recording session 7** in <#123>.\n${WORDING}${CLOSING}`);
  });

  it("adds one disclosure sentence when an online service summarizes automatically", () => {
    const text = recordingNotice({ sessionNumber: 6, channel: "<#123>", llm: { provider: "anthropic" }, autoSummarize: true });
    expect(text).toBe(
      `🔴 **Recording session 6** in <#123>.\n${WORDING}` +
        "The summary is written by an online AI service (anthropic), so the transcript is sent to it. " +
        CLOSING,
    );
  });
});

describe("isLocalSummarizer", () => {
  it.each([
    ["http://localhost:11434/v1", true],
    ["http://127.0.0.1:8080/v1", true],
    ["http://[::1]:11434/v1", true],
    ["http://192.168.1.20:11434/v1", true],
    ["http://10.0.0.5/v1", true],
    ["http://172.20.0.2/v1", true],
    ["http://ollama-box.local:11434/v1", true],
    ["https://api.openai.com/v1", false],
    ["http://172.32.0.1/v1", false],
    ["not a url", false],
  ])("openai-compatible at %s → %s", (url, local) => {
    expect(isLocalSummarizer({ provider: "openai-compatible", openaiBaseUrl: url })).toBe(local);
  });

  it("treats hosted providers as online", () => {
    expect(isLocalSummarizer({ provider: "anthropic" })).toBe(false);
    expect(isLocalSummarizer({ provider: "xai", openaiBaseUrl: "http://localhost:11434/v1" })).toBe(false);
  });
});
