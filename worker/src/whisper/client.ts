import { JobError, errorCodeForHttpStatus } from "../errors.js";
import { createFetchWithTimeouts, createMultipartBody } from "../http/timeout-fetch.js";
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
  /**
   * The user's custom vocabulary, as assembled by `shared/src/vocabulary.ts`. Capped there, not
   * here: the backend keeps only the tail of an over-long prompt and says nothing.
   */
  prompt?: string | undefined;
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
  /**
   * Send `vad_filter=true`, which makes the backend run Silero VAD and hand the
   * model only the parts that contain speech. On by default: a recording with a
   * long speechless stretch otherwise drives every Whisper size into a
   * repetition loop that contaminates the rest of the transcript. The cost is
   * that audio the VAD considers silence is never transcribed.
   *
   * Backends that do not implement the field ignore it, so this stays inside the
   * OpenAI-compatible surface of ADR-005.
   */
  vadFilter?: boolean;
  /**
   * Overrides the transport. The default one carries the timeouts derived from
   * `timeoutMs`, so a substitute is for tests only — a plain global `fetch`
   * would reinstate undici's five-minute headers timeout.
   */
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
 *
 * The `prompt` field is part of the OpenAI-compatible surface; a backend that ignores it simply
 * transcribes without the bias.
 *
 * The silence filter (`vad_filter`) is on unless configuration turns it off; see
 * `OpenAiTranscriptionClientOptions.vadFilter`. It changes only which audio the
 * model is shown — the timestamps that come back stay relative to the start of
 * the submitted recording, so nothing downstream has to compensate for it.
 *
 * A transcription backend answers when the transcript is finished, which is what
 * makes `timeoutMs` the whole point of this client: it has to reach the
 * transport, not just the `AbortController` (see `http/timeout-fetch.ts`).
 */
export class OpenAiTranscriptionClient implements TranscriptionClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly vadFilter: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiTranscriptionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.vadFilter = options.vadFilter ?? true;
    this.fetchImpl = options.fetchImpl ?? createFetchWithTimeouts(this.timeoutMs);
  }

  async transcribe(request: TranscriptionRequest): Promise<WhisperTranscriptionResponse> {
    const form = createMultipartBody();
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
    if (request.prompt) form.append("prompt", request.prompt);
    // Omitted rather than sent as `false` when off, so a backend that does not
    // know the field never sees it at all.
    if (this.vadFilter) form.append("vad_filter", "true");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    // The budget has to cover reading the response, not just obtaining it:
    // headers can arrive within it and leave the body to be streamed
    // afterwards, and an attempt stuck there is exactly as stuck as one waiting
    // for headers. Clearing the timer only after the transcript is parsed makes
    // the configured value a whole-request limit in fact and not just in name.
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
          method: "POST",
          body: form,
          signal: controller.signal,
          ...(this.apiKey ? { headers: { authorization: `Bearer ${this.apiKey}` } } : {}),
        });
      } catch (error) {
        if (controller.signal.aborted) throw this.budgetExceeded(error);
        // Connection refused, DNS failure, timeout: the backend may still be
        // starting up or reloading a model, so this is always worth a retry.
        throw new JobError(
          "TRANSCRIPTION_UNAVAILABLE",
          `transcription request to ${this.baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: true, cause: error },
        );
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
        // A body cut short by our own deadline is a slow backend, not a
        // malformed answer — the difference decides whether the job retries.
        if (controller.signal.aborted) throw this.budgetExceeded(error);
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
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The attempt ran out of its own budget. Retryable: a backend that needs more
   * time than it was given is a capacity problem, and the next attempt may find
   * a warmed-up model or a shorter queue. The message names no address — it
   * reaches the user through the job's failure reason.
   */
  private budgetExceeded(cause: unknown): JobError {
    return new JobError(
      "TRANSCRIPTION_UNAVAILABLE",
      `transcription did not finish within its ${this.timeoutMs} ms budget`,
      { retryable: true, cause },
    );
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
