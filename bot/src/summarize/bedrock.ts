import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { withoutReserved } from "./api-options.js";
import { parseJson } from "./gemini.js";
import { LLMError, type JsonRequest, type LLMProvider } from "./provider.js";

export interface BedrockOptions {
  /** A model id or inference profile, e.g. us.anthropic.claude-…, amazon.nova-pro-v1:0, an ARN. */
  model: string;
  /** Blank: the AWS SDK's own (AWS_REGION, the profile's region). */
  region?: string;
  /** A named profile from ~/.aws/config; blank = the default credential chain. */
  profile?: string;
  /** A Bedrock API key (AWS_BEARER_TOKEN_BEDROCK): bearer auth instead of signed AWS credentials. */
  bearerToken?: string;
  /** A VPC or FIPS endpoint (AWS_ENDPOINT_URL_BEDROCK_RUNTIME). */
  endpoint?: string;
  headers?: Record<string, string>;
  /** Extra Converse request fields (LLM_REQUEST_OPTIONS): inferenceConfig, additionalModelRequestFields, guardrailConfig… */
  requestOptions?: Record<string, unknown>;
  /** Tests only: where requests go instead of the network. */
  requestHandler?: ConstructorParameters<typeof BedrockRuntimeClient>[0] extends infer C ? C extends { requestHandler?: infer H } ? H : never : never;
}

const RESERVED = ["modelId", "messages", "system", "toolConfig"] as const;
const TOOL = "answer";

/** Amazon Bedrock through the Converse API, which speaks the same shape for every model family. */
export class BedrockProvider implements LLMProvider {
  readonly name = "bedrock";
  readonly model: string;
  private client: BedrockRuntimeClient;
  private extra: Record<string, unknown>;
  /** Models without native structured output get a forced tool call instead; remembered per provider. */
  private useTool = false;

  constructor(opts: BedrockOptions) {
    this.model = opts.model;
    this.client = new BedrockRuntimeClient({
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.bearerToken ? { token: { token: opts.bearerToken }, authSchemePreference: ["httpBearerAuth"] } : {}),
      ...(opts.requestHandler ? { requestHandler: opts.requestHandler } : {}),
    });
    const headers = opts.headers ?? {};
    if (Object.keys(headers).length) {
      // Added before signing, so SigV4 covers them.
      this.client.middlewareStack.add(
        (next) => async (args) => {
          const request = args.request as { headers?: Record<string, string> };
          if (request.headers) Object.assign(request.headers, headers);
          return next(args);
        },
        { step: "build", name: "scribbotExtraHeaders" },
      );
    }
    this.extra = withoutReserved(opts.requestOptions ?? {}, RESERVED, "bedrock");
  }

  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    const { $schema: _, ...schema } = z.toJSONSchema(req.schema, { target: "draft-7" }) as Record<string, unknown>;
    if (!this.useTool) {
      try {
        return await this.converse(req, schema, false);
      } catch (err) {
        if (!isStructuredOutputUnsupported(err)) throw err;
        console.warn(`[summarize] bedrock: ${this.model} has no structured output; using a forced tool call instead`);
        this.useTool = true;
      }
    }
    return this.converse(req, schema, true);
  }

  private async converse<S extends z.ZodType>(req: JsonRequest<S>, schema: Record<string, unknown>, tool: boolean): Promise<z.infer<S>> {
    const { inferenceConfig, outputConfig, ...extra } = this.extra as {
      inferenceConfig?: Record<string, unknown>;
      outputConfig?: Record<string, unknown>;
    } & Record<string, unknown>;
    const input = {
      ...extra,
      modelId: this.model,
      system: [{ text: req.system }],
      messages: [{ role: "user", content: [{ text: req.prompt }] }],
      inferenceConfig: { maxTokens: req.maxTokens ?? 16000, ...inferenceConfig },
      ...(tool
        ? {
            ...(outputConfig ? { outputConfig } : {}),
            toolConfig: {
              tools: [{ toolSpec: { name: TOOL, description: `Return the ${req.schemaName}.`, inputSchema: { json: schema } } }],
              toolChoice: { tool: { name: TOOL } },
            },
          }
        : {
            outputConfig: {
              ...outputConfig,
              textFormat: { type: "json_schema", structure: { jsonSchema: { schema: JSON.stringify(schema), name: req.schemaName } } },
            },
          }),
    } as ConverseCommandInput;
    let out: ConverseCommandOutput;
    try {
      out = await this.client.send(new ConverseCommand(input));
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (["UnrecognizedClientException", "AccessDeniedException", "ExpiredTokenException", "CredentialsProviderError"].includes(name)) {
        throw new LLMError(`bedrock rejected the credentials (${name}): ${(err as Error).message.slice(0, 300)}`);
      }
      throw err;
    }
    if (out.stopReason === "max_tokens") throw new LLMError(`bedrock output hit maxTokens for ${req.schemaName}`);
    if (out.stopReason === "guardrail_intervened" || out.stopReason === "content_filtered") {
      throw new LLMError(`bedrock declined the request (${out.stopReason})`);
    }
    const content = out.output?.message?.content ?? [];
    if (tool) {
      const use = content.find((c) => c.toolUse?.name === TOOL)?.toolUse;
      if (use?.input !== undefined) {
        const parsed = req.schema.safeParse(use.input);
        if (!parsed.success) throw new LLMError(`bedrock output did not match ${req.schemaName}: ${parsed.error.message}`);
        return parsed.data;
      }
    }
    const text = content.map((c) => c.text ?? "").join("");
    if (!text) throw new LLMError(`bedrock returned no answer (${out.stopReason ?? "no stop reason"})`);
    return parseJson("bedrock", req, text);
  }
}

/** A ValidationException saying the model doesn't take outputConfig / structured output. */
function isStructuredOutputUnsupported(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e.name === "ValidationException" && /output ?config|textformat|structured output|json_schema/i.test(e.message ?? "");
}
