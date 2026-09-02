import { z } from "zod";
import { TranscriptionLanguageSchema } from "./transcription-language.js";
import { VocabularySchema } from "./vocabulary.js";

/**
 * Preferences that belong to a user rather than to a meeting or a template (ADR-001: stored under
 * the tenant and user scope like everything else).
 *
 * These are defaults, not settings the pipeline reads directly: a preference here answers "what
 * should a new recording start out as", and the recording keeps its own copy of what it was
 * actually started with. Changing a default therefore never rewrites the past.
 *
 * `null` means the user has expressed no preference, which is a different state from picking
 * `auto`: no preference falls through to the deployment default, `auto` asks for detection.
 */
export const UserSettingsSchema = z.object({
  transcriptionLanguage: TranscriptionLanguageSchema.nullable().default(null),
  /**
   * Terms the transcription is biased towards. Empty rather than nullable: a user who has added
   * nothing has an empty vocabulary, and there is no second meaning for "not chosen" here the way
   * there is for the language.
   */
  vocabulary: VocabularySchema.default([]),
});

/** The body of an update. Every field is optional; an absent field is left as it is. */
export const UserSettingsUpdateSchema = z.object({
  transcriptionLanguage: TranscriptionLanguageSchema.nullable().optional(),
  /**
   * The whole list, not a term to add or remove. It is capped at forty entries, so sending it
   * entire costs nothing and spares both sides a merge whose outcome depends on the order two
   * tabs happened to save in.
   */
  vocabulary: VocabularySchema.optional(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
export type UserSettingsUpdate = z.infer<typeof UserSettingsUpdateSchema>;
