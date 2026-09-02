import { describe, expect, it } from "vitest";
import {
  AUTODETECT_LANGUAGE,
  TRANSCRIPTION_LANGUAGES,
  TranscriptionLanguageSchema,
  resolveTranscriptionLanguage,
  transcriptionLanguageRequest,
} from "../src/transcription-language.js";

/**
 * The chain, written out the way the system reads it: the meeting's own choice, then the user's
 * default, then the deployment default, then autodetect.
 *
 * The arguments are positional on purpose — the order *is* the policy, and a test that named them
 * would still pass if the implementation reordered them.
 */
function chain(
  meeting: string | null,
  userDefault: string | null,
  deployment: string | null,
): string | undefined {
  return transcriptionLanguageRequest(meeting, userDefault, deployment);
}

describe("transcription language chain", () => {
  it("uses the language chosen for this meeting", () => {
    expect(chain("fr", "de", "en")).toBe("fr");
  });

  it("falls back to the user's default when the meeting chose nothing", () => {
    expect(chain(null, "de", "en")).toBe("de");
  });

  it("falls back to the deployment default when the user has no default", () => {
    expect(chain(null, null, "en")).toBe("en");
  });

  it("detects the language when nothing anywhere states one", () => {
    expect(chain(null, null, null)).toBeUndefined();
  });

  it("treats an explicit request for detection as a statement, not as silence", () => {
    // Otherwise a user who deliberately picks detection for one meeting would be overruled by
    // their own default, or by whatever the installation is configured with.
    expect(chain(AUTODETECT_LANGUAGE, "de", "en")).toBeUndefined();
    expect(chain(null, AUTODETECT_LANGUAGE, "en")).toBeUndefined();
  });

  it("reads a blank value as no statement at all", () => {
    // An unset environment variable arrives as an empty string often enough that sending it on
    // would mean `language=` on the wire.
    expect(chain(null, "  ", "en")).toBe("en");
    expect(chain("", "", "")).toBeUndefined();
  });

  it("resolves in prefixes, so the two halves of the chain can live in two processes", () => {
    // The API resolves what it knows and puts it in the job payload; the worker completes it.
    // Doing it in two steps has to give what doing it at once gives.
    for (const meeting of [null, AUTODETECT_LANGUAGE, "fr"]) {
      for (const userDefault of [null, AUTODETECT_LANGUAGE, "de"]) {
        for (const deployment of [null, "en"]) {
          const apiSide = resolveTranscriptionLanguage(meeting, userDefault);
          expect(transcriptionLanguageRequest(apiSide, deployment)).toBe(
            chain(meeting, userDefault, deployment),
          );
        }
      }
    }
  });
});

describe("the languages on offer", () => {
  it("puts detection first, because that is where a user with no opinion belongs", () => {
    expect(TRANSCRIPTION_LANGUAGES[0]).toBe(AUTODETECT_LANGUAGE);
  });

  it("refuses a tag the pickers do not offer", () => {
    // The stored value ends up as the `language` field of a transcription request, and a backend
    // answers a tag it does not know with a rejection rather than with a transcript.
    expect(TranscriptionLanguageSchema.safeParse("de").success).toBe(true);
    expect(TranscriptionLanguageSchema.safeParse("kl").success).toBe(false);
  });
});
