import { JobError, errorCodeForHttpStatus } from "../errors.js";
import {
  WhisperTranscriptionResponseSchema,
  type WhisperTranscriptionResponse,
} from "./response.js";

export interface TranscriptionRequest {
  audio: Uint8Array;
  filename: string;
  contentType: string;
  /** BCP-47 hint; omitted to let the backend detect the language. */
  language?: string | undefined;
}

/** Port so the job handler can be exercised without an HTTP backend. */
export interface TranscriptionClient {
  readonly model: string;
  transcribe(request: TranscriptionRequest): Promise<WhisperTranscriptionResponse>;
}

export interface OpenAiTranscriptionClientOptions {
  /** Base URL including the `/v1` suffix (ADR-005: the only knob that changes). */
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Speaks nothing but the OpenAI-compatible transcription API, which is what
 * makes `speaches`, a whisperX serving wrapper and host-native whisper.cpp
 * interchangeable by configuration (ADR-005, ADR-006 §6).
 *
 * Word-level timestamps are requested unconditionally — ADR-003 §4 makes them a
 * day-one requirement, and the backends that cannot produce them simply return
 * segments without words, which the mapping handles.
 */
export class OpenAiTranscriptionClient implements TranscriptionClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiTranscriptionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(request: TranscriptionRequest): Promise<WhisperTranscriptionResponse> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([toArrayBuffer(request.audio)], { type: request.contentType }),
      request.filename,
    );
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (request.language) form.append("language", request.language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: controller.signal,
        ...(this.apiKey ? { headers: { authorization: `Bearer ${this.apiKey}` } } : {}),
      });
    } catch (error) {
      // Connection refused, DNS failure, timeout: the backend may still be
      // starting up or reloading a model, so this is always worth a retry.
      throw new JobError(
        "TRANSCRIPTION_UNAVAILABLE",
        `transcription request to ${this.baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const { code, retryable } = errorCodeForHttpStatus(response.status);
      const detail = (await safeText(response)).slice(0, 500);
      throw new JobError(
        code,
        `transcription backend answered ${response.status}${detail ? `: ${detail}` : ""}`,
        { retryable },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new JobError(
        "TRANSCRIPTION_RESPONSE_INVALID",
        "transcription backend did not return JSON",
        { retryable: false, cause: error },
      );
    }

    const parsed = WhisperTranscriptionResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new JobError(
        "TRANSCRIPTION_RESPONSE_INVALID",
        `transcription response does not match the OpenAI-compatible shape: ${parsed.error.message}`,
        { retryable: false },
      );
    }
    return parsed.data;
  }
}

/**
 * Copies the assembled audio into a plain `ArrayBuffer`. `Blob` does not accept
 * a view backed by a `SharedArrayBuffer`, and the copy keeps the payload stable
 * for the lifetime of the request.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
