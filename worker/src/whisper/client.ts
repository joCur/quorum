import { FormData } from "undici";
import { JobError, errorCodeForHttpStatus } from "../errors.js";
import {
  createTimeoutDispatcher,
  describeFetchFailure,
  requestTimeoutOptions,
  timeoutAwareFetch,
  type Dispatcher,
  type FetchImpl,
  type RequestTimeoutOptions,
} from "../http/fetch.js";
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
  /**
   * Whole-request budget for one transcription. It governs both the wait for
   * response headers — a transcription backend stays silent until the transcript
   * is done — and the abort signal.
   */
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
  /** Substituted in tests; production derives one from `timeoutMs`. */
  dispatcher?: Dispatcher;
  fetchImpl?: FetchImpl;
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
 * The silence filter (`vad_filter`) is on unless configuration turns it off; see
 * `OpenAiTranscriptionClientOptions.vadFilter`. It changes only which audio the
 * model is shown — the timestamps that come back stay relative to the start of
 * the submitted recording, so nothing downstream has to compensate for it.
 */
export class OpenAiTranscriptionClient implements TranscriptionClient {
  readonly model: string;
  /**
   * The undici timeouts derived from `timeoutMs`, exposed so the configured
   * value can be pinned without reaching into the dispatcher's internals.
   */
  readonly requestTimeouts: RequestTimeoutOptions;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly vadFilter: boolean;
  private readonly dispatcher: Dispatcher;
  private readonly fetchImpl: FetchImpl;

  constructor(options: OpenAiTranscriptionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.vadFilter = options.vadFilter ?? true;
    this.requestTimeouts = requestTimeoutOptions(this.timeoutMs);
    // One dispatcher per client, not per request: it owns the connection pool.
    this.dispatcher = options.dispatcher ?? createTimeoutDispatcher(this.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? timeoutAwareFetch;
  }

  async transcribe(request: TranscriptionRequest): Promise<WhisperTranscriptionResponse> {
    // undici's `FormData`, not the global one: the imported `fetch` recognizes
    // only its own and would otherwise post the string "[object FormData]".
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
    // Omitted rather than sent as `false` when off, so a backend that does not
    // know the field never sees it at all.
    if (this.vadFilter) form.append("vad_filter", "true");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: controller.signal,
        dispatcher: this.dispatcher,
        ...(this.apiKey ? { headers: { authorization: `Bearer ${this.apiKey}` } } : {}),
      });
    } catch (error) {
      // Connection refused, DNS failure, timeout: the backend may still be
      // starting up or reloading a model, so this is always worth a retry.
      throw new JobError(
        "TRANSCRIPTION_UNAVAILABLE",
        `transcription request to ${this.baseUrl} failed: ${describeFetchFailure(error)}`,
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
