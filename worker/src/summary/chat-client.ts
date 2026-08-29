import { z } from "zod";
import { JobError, summaryErrorCodeForHttpStatus } from "../errors.js";

/**
 * The summary backend, reduced to the one call ADR-005 §2 commits to:
 * `POST {base}/chat/completions` in the OpenAI-compatible shape.
 *
 * Nothing above this file knows which provider is behind the URL. Moving from
 * OpenRouter to LM Studio, vLLM or Ollama is `SUMMARY_BASE_URL`,
 * `SUMMARY_MODEL` and possibly `SUMMARY_API_KEY` — no code change, which is the
 * acceptance criterion of the ticket this implements.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResult {
  content: string;
  /** Reported by the backend when it bothers to; used for cost logging only. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** `"length"` means the answer was cut off — worth logging, and usually fatal to JSON. */
  finishReason: string | null;
  /** The model the backend says it actually used; routers substitute freely. */
  model: string | null;
}

/** Port so the handler can be exercised without an HTTP backend. */
export interface ChatCompletionClient {
  readonly model: string;
  complete(messages: ChatMessage[]): Promise<ChatCompletionResult>;
}

/**
 * Only the fields we consume are required. Everything else a provider adds is
 * ignored on purpose: being strict about a response envelope is how an
 * "OpenAI-compatible" abstraction stops being compatible.
 */
const ChatCompletionResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish() }).optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
    })
    .nullish(),
});

export interface OpenAiChatClientOptions {
  /** Base URL including the `/v1` suffix (ADR-005: the only knob that changes). */
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /**
   * Send `response_format: {"type":"json_object"}`. Off by default: OpenAI and
   * OpenRouter accept it, but several self-hosted servers answer 400 to a field
   * they do not implement, which would break the provider swap that ADR-005 is
   * about. The prompt asks for JSON regardless, and the parser is written for
   * models that ignore the instruction.
   */
  jsonMode?: boolean;
  fetchImpl?: typeof fetch;
}

export class OpenAiChatClient implements ChatCompletionClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly jsonMode: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiChatClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0.2;
    this.maxOutputTokens = options.maxOutputTokens ?? 4_000;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.jsonMode = options.jsonMode ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(messages: ChatMessage[]): Promise<ChatCompletionResult> {
    const body = {
      model: this.model,
      messages,
      // Low but not zero: summaries should be reproducible in substance, and
      // greedy decoding makes some models loop on repetitive transcripts.
      temperature: this.temperature,
      max_tokens: this.maxOutputTokens,
      stream: false,
      ...(this.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // Connection refused, DNS failure, timeout: a hosted router has a bad
      // minute, a self-hosted server is still loading the model. Retry.
      throw new JobError(
        "SUMMARY_UNAVAILABLE",
        `summary request to ${this.baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const { code, retryable } = summaryErrorCodeForHttpStatus(response.status);
      const detail = (await safeText(response)).slice(0, 500);
      throw new JobError(
        code,
        `summary backend answered ${response.status}${detail ? `: ${detail}` : ""}`,
        { retryable },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new JobError("SUMMARY_RESPONSE_INVALID", "summary backend did not return JSON", {
        retryable: false,
        cause: error,
      });
    }

    const parsed = ChatCompletionResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new JobError(
        "SUMMARY_RESPONSE_INVALID",
        `summary response is not an OpenAI-compatible chat completion: ${parsed.error.message}`,
        { retryable: false },
      );
    }

    const choice = parsed.data.choices[0];
    const content = choice?.message?.content ?? "";
    if (content.trim().length === 0) {
      throw new JobError("SUMMARY_RESPONSE_INVALID", "summary backend returned an empty message", {
        retryable: false,
      });
    }

    return {
      content,
      promptTokens: parsed.data.usage?.prompt_tokens ?? null,
      completionTokens: parsed.data.usage?.completion_tokens ?? null,
      finishReason: choice?.finish_reason ?? null,
      model: parsed.data.model ?? null,
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
