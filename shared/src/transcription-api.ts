import { z } from "zod";
import { JobSchema } from "./job.js";

/**
 * HTTP contract for running a meeting's transcription again (ADR-005: the work is a server-side
 * job, so the API hands back the job rather than the transcript).
 *
 * There is no request body. Which job is re-enqueued is not the caller's choice: it is the
 * meeting's failed `transcribe` job, resolved on the server under the caller's tenant and user,
 * and a client that could name a job id could name someone else's.
 */

export const TranscriptionJobAcceptedSchema = z.object({
  job: JobSchema,
});

export type TranscriptionJobAccepted = z.infer<typeof TranscriptionJobAcceptedSchema>;
