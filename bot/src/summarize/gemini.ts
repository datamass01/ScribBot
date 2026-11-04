import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { withoutReserved } from "./api-options.js";
import { API_DEFAULT_MODELS } from "./defaults.js";
import { LLMError, type JsonRequest, type LLMProvider } from "./provider.js";


export interface GeminiOptions {
  /** `vertex-ai`: Google Cloud (project, location, application default credentials); `gemini`: the Gemini API with a key. */
  vertex: boolean;
  model?: string;
  apiKey?: string;
  project?: string;
  location?: string;
  /** A service-account JSON file; blank = application default credentials (`gcloud auth application-default login`). */
  keyFile?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  /** Extra GenerateContentConfig fields (LLM_REQUEST_OPTIONS), e.g. temperature, thinkingConfig, safetySettings. */
  requestOptions?: Record<string, unknown>;
}

/** Config fields ScribBot must set itself: the system prompt and the JSON output. */
const RESERVED = ["systemInstruction", "responseMimeType", "responseSchema", "responseJsonSchema"] as const;

/** Google Gemini, through the Gemini API (an API key) or Vertex AI (a Google Cloud project). */
export class GeminiProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private client: GoogleGenAI;
  private extra: Record<string, unknown>;

  constructor(opts: GeminiOptions) {
    this.name = opts.vertex ? "vertex-ai" : "gemini";
    this.model = opts.model ?? API_DEFAULT_MODELS[this.name === "vertex-ai" ? "vertex-ai" : "gemini"];
    const httpOptions = {
      timeout: 20 * 60_000,
      ...(opts.baseURL ? { baseUrl: opts.baseURL } : {}),
      ...(opts.headers && Object.keys(opts.headers).length ? { headers: opts.headers } : {}),
    };
    this.client = opts.vertex
      ? new GoogleGenAI({
          vertexai: true,
          ...(opts.apiKey ? { apiKey: opts.apiKey } : { project: opts.project, location: opts.location || "global" }),
          ...(opts.keyFile ? { googleAuthOptions: { keyFilename: opts.keyFile } } : {}),
          httpOptions,
        })
      : new GoogleGenAI({ apiKey: opts.apiKey ?? "", httpOptions });
    this.extra = withoutReserved(opts.requestOptions ?? {}, RESERVED, this.name);
  }

  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    const { $schema: _, ...schema } = z.toJSONSchema(req.schema, { target: "draft-7" }) as Record<string, unknown>;
    const config = {
      maxOutputTokens: req.maxTokens ?? 16000,
      ...this.extra,
      systemInstruction: req.system,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    };
    let res;
    try {
      res = await this.client.models.generateContent({ model: this.model, contents: req.prompt, config });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        throw new LLMError(`${this.name} rejected the credentials (${status}): ${(err as Error).message.slice(0, 300)}`);
      }
      throw err;
    }
    const blocked = res.promptFeedback?.blockReason;
    if (blocked) throw new LLMError(`${this.name} blocked the prompt (${blocked})`);
    const candidate = res.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new LLMError(`${this.name} output hit maxOutputTokens (${String(config.maxOutputTokens)}) for ${req.schemaName}`);
    }
    const text = res.text;
    if (!text) throw new LLMError(`${this.name} returned no text${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}`);
    return parseJson(this.name, req, text);
  }
}

/** The JSON object in `text` (some endpoints wrap it in prose or code fences), checked against the schema. */
export function parseJson<S extends z.ZodType>(name: string, req: JsonRequest<S>, text: string): z.infer<S> {
  let value: unknown;
  try {
    value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new LLMError(`${name} didn't return JSON for ${req.schemaName}`);
  }
  const parsed = req.schema.safeParse(value);
  if (!parsed.success) throw new LLMError(`${name} output did not match ${req.schemaName}: ${parsed.error.message}`);
  return parsed.data;
}
