import OpenAI from "openai";
import { z } from "zod";
import { LLMError, type JsonRequest, type LLMProvider } from "./provider.js";

/** xAI Grok, OpenAI, Ollama, LM Studio, OpenRouter: anything speaking the Chat Completions API. */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: { name: string; baseURL?: string; apiKey: string; model: string }) {
    this.name = opts.name;
    this.model = opts.model;
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
  }

  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7" });
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, schema: jsonSchema as Record<string, unknown>, strict: true },
      },
    });

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
