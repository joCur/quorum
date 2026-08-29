import type { JobQueue } from "../types.js";

/** In-memory job queue for tests and for running the server without Postgres. */
export class InMemoryJobQueue implements JobQueue {
  readonly enqueued: Array<{
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
  }> = [];
  /** Set to make the next enqueue fail — used to test finalization failures. */
  failNextEnqueue = false;

  async enqueueTranscribe(input: {
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<void> {
    if (this.failNextEnqueue) {
      this.failNextEnqueue = false;
      throw new Error("simulated queue failure");
    }
    this.enqueued.push(input);
  }
}
