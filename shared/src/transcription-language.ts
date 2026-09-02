import { z } from "zod";

/**
 * Which language a recording is transcribed in.
 *
 * WHY THIS IS NOT ONE GLOBAL SETTING: Whisper detects the language from the first half minute of
 * audio, and a meeting that opens with shuffling chairs instead of speech makes it guess — a wrong
 * guess is not a wrong label, it decodes the entire recording as if it were that language. A fixed
 * deployment default protects a single-language installation and breaks the first meeting held in
 * another one, so the choice belongs to the meeting.
 *
 * THE CHAIN, most specific first:
 *   1. the choice made for this meeting before recording started,
 *   2. the user's default from their settings,
 *   3. the deployment default (`WHISPER_LANGUAGE`),
 *   4. autodetect.
 *
 * `resolveTranscriptionLanguage` is the whole chain and nothing else: each link either states
 * something or says nothing, and the first that states something wins. That makes it composable —
 * the links are not all known in one process. The server knows the meeting's choice and the user's
 * default; the deployment default is worker configuration, because ADR-005 keeps the shape of the
 * transcription request on the side that makes it. Resolving a prefix of the chain and feeding the
 * result into the rest gives the same answer as resolving all of it at once.
 */

/** The link value that means "detect it from the audio" rather than "say nothing". */
export const AUTODETECT_LANGUAGE = "auto";

/**
 * What the pickers offer. Any of these may be stored, and `auto` is a statement like any other: a
 * user who picks it for one meeting has decided against their own default, not fallen off the end
 * of the chain.
 *
 * The list is short on purpose — these are the languages the product is used in today. Widening it
 * is a one-line change here plus a label in each catalog, which is what keeps a picker of a hundred
 * entries from being the first thing a new user has to read past.
 */
export const TRANSCRIPTION_LANGUAGES = [
  AUTODETECT_LANGUAGE,
  "de",
  "en",
  "fr",
  "es",
  "it",
  "nl",
  "pt",
] as const;

export const TranscriptionLanguageSchema = z.enum(TRANSCRIPTION_LANGUAGES);

export type TranscriptionLanguage = z.infer<typeof TranscriptionLanguageSchema>;

/**
 * The first link of the chain that states something, or `null` when none does.
 *
 * A link says nothing when it is absent, `null`, or blank — an unset environment variable arrives
 * as an empty string often enough that treating it as a statement would silently send `language=`
 * to the backend. The result may be `AUTODETECT_LANGUAGE`: that is a statement, and it stops the
 * chain rather than falling through to the deployment default.
 */
export function resolveTranscriptionLanguage(
  ...preferences: readonly (string | null | undefined)[]
): string | null {
  for (const preference of preferences) {
    const stated = preference?.trim();
    if (stated) return stated;
  }
  return null;
}

/**
 * The value to send as the transcription request's `language` field, or `undefined` to let the
 * backend detect it.
 *
 * The two ways of arriving at autodetect — nobody stated anything, and somebody stated `auto` —
 * are one and the same request, which is why they collapse here at the last moment rather than
 * anywhere the distinction still matters.
 */
export function transcriptionLanguageRequest(
  ...preferences: readonly (string | null | undefined)[]
): string | undefined {
  const resolved = resolveTranscriptionLanguage(...preferences);
  return resolved === null || resolved === AUTODETECT_LANGUAGE ? undefined : resolved;
}
