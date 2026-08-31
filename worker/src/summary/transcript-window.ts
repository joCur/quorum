import type { Segment, Transcript } from "@quorum/shared";

/**
 * Turning a transcript into prompt text within a token budget.
 *
 * WHY A BUDGET AT ALL: `docs/COST-MODEL.md` assumes 12–15k input tokens per meeting
 * hour, which is roughly what an hour of speech transcribes to. That assumption
 * is what makes the per-hour marginal cost predictable, so the worker enforces
 * it instead of trusting every meeting to be an hour long. A four-hour workshop
 * would otherwise quadruple the cost of one job and, on many models, simply
 * exceed the context window and fail after the tokens were already paid for.
 *
 * WHY HEAD AND TAIL: dropping the tail would be the easy implementation and the
 * wrong one. Meetings put their framing at the start and their decisions and
 * action items at the end; the negotiation in the middle is the most
 * compressible part. So the window keeps a smaller head and a larger tail and
 * elides the middle, with a visible marker telling the model that time was cut
 * out — an unmarked jump would invite it to invent a bridge between two
 * unrelated moments.
 *
 * The split is deterministic and happens on segment boundaries, so the same
 * transcript always produces the same prompt — which is what makes a replayed
 * job reproduce its summary rather than pay for a different one.
 */

/** Fraction of the budget spent on the beginning of the meeting. */
const HEAD_SHARE = 0.4;

/**
 * Rough token estimate. Four characters per token is the usual English/German
 * ballpark for byte-pair vocabularies; the worker never needs to be exact, it
 * needs to be conservative and dependency-free — pulling a tokenizer in would
 * tie the estimate to one model family, which is exactly what ADR-005 avoids.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TranscriptWindow {
  /** The transcript rendered as prompt text, possibly with the middle elided. */
  text: string;
  /** Segments actually included. */
  includedSegments: number;
  totalSegments: number;
  /** `true` when the middle was cut out. */
  truncated: boolean;
  estimatedTokens: number;
}

function timestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * One line per segment: a timestamp, the speaker if diarization has named one,
 * and the text. `editedText` wins over `text` where a user has corrected the
 * machine output — the overlay of ADR-003 §2 is the better source, and reading
 * it here does not violate the immutability of `text`.
 *
 * Returns `null` for a segment with no words in it; silence should not cost
 * tokens.
 */
export function renderSegment(segment: Segment, speakerLabels: Map<string, string>): string | null {
  const body = (segment.editedText ?? segment.text).trim();
  if (body.length === 0) return null;
  const speakerId = segment.editedSpeakerId ?? segment.speakerId;
  const speaker = speakerId ? speakerLabels.get(speakerId) : undefined;
  return `[${timestamp(segment.start)}]${speaker ? ` ${speaker}:` : ""} ${body}`;
}

export function windowTranscript(transcript: Transcript, maxTokens: number): TranscriptWindow {
  const speakerLabels = new Map(transcript.speakers.map((speaker) => [speaker.id, speaker.label]));
  const lines = transcript.segments
    .map((segment) => renderSegment(segment, speakerLabels))
    .filter((line): line is string => line !== null);

  const full = lines.join("\n");
  if (lines.length === 0 || estimateTokens(full) <= maxTokens) {
    return {
      text: full,
      includedSegments: lines.length,
      totalSegments: transcript.segments.length,
      truncated: false,
      estimatedTokens: estimateTokens(full),
    };
  }

  const headBudget = Math.floor(maxTokens * HEAD_SHARE);
  const tailBudget = maxTokens - headBudget;

  const head: string[] = [];
  let headTokens = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (headTokens + cost > headBudget) break;
    head.push(line);
    headTokens += cost;
  }

  const tail: string[] = [];
  let tailTokens = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    const line = lines[index] as string;
    const cost = estimateTokens(line) + 1;
    if (tailTokens + cost > tailBudget) break;
    tail.unshift(line);
    tailTokens += cost;
  }

  const omitted = lines.length - head.length - tail.length;
  const marker = `\n[... ${omitted} transcript segments omitted to fit the model's input budget ...]\n`;
  const text = [head.join("\n"), marker, tail.join("\n")].join("");

  return {
    text,
    includedSegments: head.length + tail.length,
    totalSegments: transcript.segments.length,
    truncated: omitted > 0,
    estimatedTokens: estimateTokens(text),
  };
}
