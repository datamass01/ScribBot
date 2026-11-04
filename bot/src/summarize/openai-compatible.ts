import OpenAI from "openai";
import { z } from "zod";
import { withoutReserved } from "./api-options.js";
import { LLMError, type JsonRequest, type LLMProvider } from "./provider.js";

/** Body fields ScribBot must set itself. */
const RESERVED = ["model", "messages", "response_format", "stream"] as const;

/** xAI Grok, OpenAI, Azure OpenAI, Ollama, LM Studio, OpenRouter: anything speaking the Chat Completions API. */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;
  private extra: Record<string, unknown>;

  constructor(opts: {
    name: string;
    baseURL?: string;
    apiKey: string;
    model: string;
    headers?: Record<string, string>;
    /** Extra Chat Completions body fields (LLM_REQUEST_OPTIONS); they override ScribBot's defaults. */
    requestOptions?: Record<string, unknown>;
    /** A client built elsewhere (Azure OpenAI's AzureOpenAI); baseURL, apiKey and headers are then unused. */
    client?: OpenAI;
  }) {
    this.name = opts.name;
    this.model = opts.model;
    this.client =
      opts.client ??
      new OpenAI({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
        ...(opts.headers && Object.keys(opts.headers).length ? { defaultHeaders: opts.headers } : {}),
      });
    this.extra = withoutReserved(opts.requestOptions ?? {}, RESERVED, opts.name);
  }

  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7" });
    // Newer OpenAI models take max_completion_tokens instead of max_tokens; only one may be sent.
    const limit = "max_completion_tokens" in this.extra ? {} : { max_tokens: req.maxTokens ?? 16000 };
    const params = {
      ...limit,
      ...this.extra,
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, schema: jsonSchema as Record<string, unknown>, strict: true },
      },
      stream: false,
    };
    // The extra fields are the user's to get right; the server rejects ones it doesn't know.
    const completion = (await this.client.chat.completions.create(
      params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    )) as OpenAI.Chat.ChatCompletion;

    const choice = completion.choices[0];
    if (!choice) throw new LLMError(`${this.name} returned no choices`);
    if (choice.finish_reason === "length") throw new LLMError(`${this.name} output was truncated (max_tokens)`);
    const text = choice.message.content;
    if (!text) throw new LLMError(`${this.name} returned an empty message${choice.message.refusal ? `: ${choice.message.refusal}` : ""}`);

    // Some local servers ignore response_format and wrap JSON in prose or code fences.
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = req.schema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      throw new LLMError(`${this.name} output did not match ${req.schemaName}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}
