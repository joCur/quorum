import {
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptSchema,
  type Segment,
  type Transcript,
  type Word,
} from "@quorum/shared";
import { JobError } from "../errors.js";
import { segmentId, transcriptIdForJob } from "../ids.js";
import type {
  WhisperSegment,
  WhisperTranscriptionResponse,
  WhisperWord,
} from "../whisper/response.js";

export interface MappingInput {
  response: WhisperTranscriptionResponse;
  /** Drives the deterministic transcript and segment ids. */
  jobId: string;
  meetingId: string;
  /** Configured model name; the response may report a more specific one. */
  model: string;
  /** Absolute start of the recording (ADR-003 §5). */
  recordedAt: string;
  createdAt: string;
  /** Used when the backend reports no language at all. */
  fallbackLanguage?: string;
}

const DEFAULT_LANGUAGE = "und"; // BCP-47 "undetermined"

/**
 * Maps an OpenAI-compatible verbose transcription response onto the immutable
 * `Transcript` of ADR-003.
 *
 * Pure and deterministic: same response plus same job id gives byte-identical
 * output, which is what lets a retried job overwrite its own result instead of
 * creating a second transcript. `speakers` stays empty and every `speakerId` is
 * null until diarization exists; the user-correction overlays (`editedText`,
 * `editedSpeakerId`) are never filled by machine output.
 */
export function mapResponseToTranscript(input: MappingInput): Transcript {
  const { response } = input;
  const id = transcriptIdForJob(input.jobId);

  const rawSegments = response.segments ?? [];
  const language = response.language ?? input.fallbackLanguage ?? DEFAULT_LANGUAGE;

  const segments: Segment[] =
    rawSegments.length > 0
      ? rawSegments.map((segment, index) =>
          toSegment(segment, index, id, language, response.words ?? []),
        )
      : synthesizeSingleSegment(response, id, language);

  const candidate = {
    id,
    meetingId: input.meetingId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: input.model,
    modelVersion: response.model ?? input.model,
    language,
    recordedAt: input.recordedAt,
    createdAt: input.createdAt,
    speakers: [],
    segments,
  };

  const parsed = TranscriptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new JobError(
      "TRANSCRIPT_INVALID",
      `mapped transcript does not satisfy the transcript schema: ${parsed.error.message}`,
      { retryable: false },
    );
  }
  return parsed.data;
}

function toSegment(
  segment: WhisperSegment,
  index: number,
  transcriptId: string,
  transcriptLanguage: string,
  topLevelWords: readonly WhisperWord[],
): Segment {
  const start = clampTime(segment.start);
  const end = Math.max(start, clampTime(segment.end));
  // Prefer the words the backend attached to the segment; fall back to slicing
  // the flat top-level list, which is the shape OpenAI itself returns.
  const words = segment.words ?? wordsWithin(topLevelWords, start, end);

  return {
    id: segmentId(transcriptId, index),
    start,
    end,
    text: segment.text.trim(),
    editedText: null,
    confidence: confidenceFromLogprob(segment.avg_logprob),
    speakerId: null,
    editedSpeakerId: null,
    language: segment.language && segment.language !== transcriptLanguage ? segment.language : null,
    words: words.length > 0 ? words.map(toWord) : null,
  };
}

/**
 * A backend that returns only `text` (no segments) still has to produce a valid
 * transcript — one segment spanning the whole recording.
 */
function synthesizeSingleSegment(
  response: WhisperTranscriptionResponse,
  transcriptId: string,
  _transcriptLanguage: string,
): Segment[] {
  const text = response.text.trim();
  if (text.length === 0) return [];
  const words = response.words ?? [];
  const end = response.duration ?? words[words.length - 1]?.end ?? 0;
  return [
    {
      id: segmentId(transcriptId, 0),
      start: 0,
      end: clampTime(end),
      text,
      editedText: null,
      confidence: null,
      speakerId: null,
      editedSpeakerId: null,
      language: null,
      words: words.length > 0 ? words.map(toWord) : null,
    },
  ];
}

/**
 * Whisper prefixes each word with the space that preceded it. The segment text
 * is the authoritative rendering, so the word entry keeps only the token — that
 * is what click-on-word lookups and highlight matching need.
 */
function toWord(word: WhisperWord): Word {
  const start = clampTime(word.start);
  return { word: word.word.trim(), start, end: Math.max(start, clampTime(word.end)) };
}

/**
 * Assigns flat words to a segment by midpoint containment. Boundary words are
 * claimed by exactly one segment, so concatenating all segments' words
 * reproduces the original list without duplicates.
 */
function wordsWithin(
  words: readonly WhisperWord[],
  start: number,
  end: number,
): readonly WhisperWord[] {
  return words.filter((word) => {
    const midpoint = (word.start + word.end) / 2;
    return midpoint >= start && midpoint < end;
  });
}

/** Timestamps are seconds from the recording start and can never be negative. */
function clampTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Whisper reports a mean log probability per segment; `exp()` turns it back
 * into a 0..1 value, which is what the schema's `confidence` expects. It is a
 * rough signal, useful for flagging low-quality passages, not a calibrated
 * probability.
 */
function confidenceFromLogprob(avgLogprob: number | undefined): number | null {
  if (avgLogprob === undefined || !Number.isFinite(avgLogprob)) return null;
  return Math.min(1, Math.max(0, Math.exp(avgLogprob)));
}
