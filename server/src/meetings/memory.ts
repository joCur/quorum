import type { Job, Meeting, Summary, Transcript } from "@quorum/shared";
import type { AccountUsage, RecordingUsage } from "../recording/types.js";
import { deriveMeetingState, type StageState } from "./status.js";
import {
  DEFAULT_MEETING_LIMIT,
  MAX_MEETING_LIMIT,
  type ListMeetingsOptions,
  type MeetingDetailRow,
  type MeetingRecord,
  type MeetingScope,
  type MeetingStore,
  type RequeueOutcome,
  type RequeueTarget,
} from "./repository.js";

interface StoredMeeting extends MeetingRecord {
  finalizedAt: string | null;
  audioBytes: number;
  recordedSeconds: number;
}

/** Pipeline artifacts a test attaches to a meeting to exercise the derived status. */
export interface StoredPipeline {
  transcript?: Transcript;
  summaries?: Summary[];
  jobs?: Job[];
}

/**
 * In-memory `MeetingStore` for tests and for the unauthenticated development instance.
 *
 * It mirrors the tenant/user predicate of the SQL implementation rather than filtering after the
 * fact, so a cross-tenant read misses here for the same reason it misses in PostgreSQL.
 */
export class InMemoryMeetingStore implements MeetingStore {
  private readonly meetings = new Map<string, StoredMeeting>();
  private readonly pipelines = new Map<string, StoredPipeline>();

  async migrate(): Promise<void> {
    // Nothing to apply.
  }

  async recordSession(record: MeetingRecord): Promise<void> {
    const existing = this.meetings.get(record.meetingId);
    this.meetings.set(record.meetingId, {
      ...record,
      finalizedAt: existing?.finalizedAt ?? null,
      audioBytes: existing?.audioBytes ?? 0,
      recordedSeconds: existing?.recordedSeconds ?? 0,
    });
  }

  /** Monotonic, exactly like the `GREATEST` of the SQL implementation. */
  async recordUsage(scope: MeetingScope, sessionId: string, usage: RecordingUsage): Promise<void> {
    for (const meeting of this.meetings.values()) {
      if (
        meeting.sessionId === sessionId &&
        meeting.tenantId === scope.tenantId &&
        meeting.userId === scope.userId
      ) {
        meeting.audioBytes = Math.max(meeting.audioBytes, usage.audioBytes);
        meeting.recordedSeconds = Math.max(meeting.recordedSeconds, usage.recordedSeconds);
      }
    }
  }

  async readUsage(scope: MeetingScope, monthStart: string): Promise<AccountUsage> {
    let storageBytes = 0;
    let monthRecordedSeconds = 0;
    for (const meeting of this.meetings.values()) {
      if (meeting.tenantId !== scope.tenantId || meeting.userId !== scope.userId) continue;
      storageBytes += meeting.audioBytes;
      if (meeting.createdAt >= monthStart) monthRecordedSeconds += meeting.recordedSeconds;
    }
    return { storageBytes, monthRecordedSeconds };
  }

  async markFinalized(scope: MeetingScope, sessionId: string, finalizedAt: string): Promise<void> {
    for (const meeting of this.meetings.values()) {
      if (
        meeting.sessionId === sessionId &&
        meeting.tenantId === scope.tenantId &&
        meeting.userId === scope.userId &&
        meeting.finalizedAt === null
      ) {
        meeting.finalizedAt = finalizedAt;
      }
    }
  }

  /** Test seam: attaches transcript, summaries and job rows to an existing meeting. */
  setPipeline(meetingId: string, pipeline: StoredPipeline): void {
    this.pipelines.set(meetingId, pipeline);
  }

  async listMeetings(scope: MeetingScope, options: ListMeetingsOptions = {}): Promise<Meeting[]> {
    const limit = Math.min(options.limit ?? DEFAULT_MEETING_LIMIT, MAX_MEETING_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);
    const search = options.search?.trim().toLowerCase();

    return [...this.meetings.values()]
      .filter((meeting) => meeting.tenantId === scope.tenantId && meeting.userId === scope.userId)
      .filter(
        (meeting) =>
          search === undefined ||
          search === "" ||
          (meeting.title ?? "").toLowerCase().includes(search),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit)
      .map((meeting) => this.toMeeting(meeting));
  }

  async findMeeting(scope: MeetingScope, meetingId: string): Promise<MeetingDetailRow | null> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting || meeting.tenantId !== scope.tenantId || meeting.userId !== scope.userId) {
      return null;
    }
    const pipeline = this.pipelines.get(meetingId) ?? {};
    return {
      meeting: this.toMeeting(meeting),
      transcript: pipeline.transcript ?? null,
      summaries: pipeline.summaries ?? [],
      jobs: pipeline.jobs ?? [],
    };
  }

  /**
   * Test seam: the job ids the queue still holds an entry for.
   *
   * The SQL store asks pg-boss's own tables; there is nothing to ask here, so the answer is set
   * from outside. It is not an ornament — the two states that make the retry guard necessary,
   * a `failed` row that pg-boss is still going to repeat and a `queued` row stranded by a crash,
   * are only distinguishable through this.
   */
  setLiveQueueEntries(jobIds: Iterable<string>): void {
    this.liveQueueEntries = new Set(jobIds);
  }

  private liveQueueEntries: ReadonlySet<string> = new Set();
  /** When this store last moved a job row — the stand-in for `jobs.updated_at`. */
  private readonly jobWrittenAt = new Map<string, string>();

  /** The same decision the SQL implementation makes, in the same order. */
  async requeueFailedJob(scope: MeetingScope, target: RequeueTarget): Promise<RequeueOutcome> {
    const job = this.findJob(scope, target.meetingId, target.jobId);
    if (!job || job.status === "succeeded" || job.status === "canceled") return "nothing-to-retry";
    if (this.liveQueueEntries.has(target.jobId)) return "in-progress";

    const previous = { ...job };
    job.status = "queued";
    job.error = null;
    job.progress = null;
    job.resultId = null;
    job.startedAt = null;
    job.finishedAt = null;
    this.jobWrittenAt.set(job.id, new Date().toISOString());
    try {
      await target.enqueue();
      // The enqueue is what creates the entry the next caller will see, exactly as it does in
      // PostgreSQL — which is what makes a second retry of this job refuse rather than duplicate.
      this.liveQueueEntries = new Set(this.liveQueueEntries).add(job.id);
    } catch (error) {
      // The transaction of the SQL implementation, by hand: an enqueue that did not happen
      // leaves the row exactly as it was found.
      Object.assign(job, previous);
      this.jobWrittenAt.delete(job.id);
      throw error;
    }
    return "requeued";
  }

  private findJob(scope: MeetingScope, meetingId: string, jobId: string): Job | undefined {
    const meeting = this.meetings.get(meetingId);
    if (!meeting || meeting.tenantId !== scope.tenantId || meeting.userId !== scope.userId) {
      return undefined;
    }
    return (this.pipelines.get(meetingId)?.jobs ?? []).find((job) => job.id === jobId);
  }

  async deleteMeeting(scope: MeetingScope, meetingId: string): Promise<boolean> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting || meeting.tenantId !== scope.tenantId || meeting.userId !== scope.userId) {
      return false;
    }
    this.meetings.delete(meetingId);
    this.pipelines.delete(meetingId);
    return true;
  }

  /** Test seam: what is left in the store, for asserting that a cascade left nothing behind. */
  get size(): number {
    return this.meetings.size + this.pipelines.size;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }

  private toMeeting(meeting: StoredMeeting): Meeting {
    const pipeline = this.pipelines.get(meeting.meetingId) ?? {};
    const transcript = pipeline.transcript ?? null;
    const state = deriveMeetingState({
      finalizedAt: meeting.finalizedAt,
      transcribe: latestStage(pipeline.jobs, "transcribe", this.jobWrittenAt),
      summarize: latestStage(pipeline.jobs, "summarize", this.jobWrittenAt),
      hasTranscript: transcript !== null,
      hasSummary: (pipeline.summaries ?? []).length > 0,
    });

    return {
      id: meeting.meetingId,
      sessionId: meeting.sessionId,
      title: meeting.title,
      status: state.status,
      audioFormat: meeting.audioFormat,
      createdAt: meeting.createdAt,
      finalizedAt: meeting.finalizedAt,
      durationSeconds: transcript ? transcriptDuration(transcript) : null,
      language: transcript?.language ?? null,
      progress: state.progress,
      hasAudio: meeting.finalizedAt !== null,
      failure: state.failure,
    };
  }
}

function latestStage(
  jobs: Job[] | undefined,
  type: Job["type"],
  writtenAt: ReadonlyMap<string, string>,
): StageState | null {
  const matches = (jobs ?? []).filter((job) => job.type === type);
  const job = matches[matches.length - 1];
  if (!job) return null;
  return {
    status: job.status,
    progress: job.progress,
    error: job.error,
    // The SQL store reads `jobs.updated_at`; there is no such column here, so the row's own
    // timestamps stand in — which is what they are, since the pipeline writes the row exactly
    // when it sets them. A row this store moved itself carries its own mark.
    updatedAt: writtenAt.get(job.id) ?? job.finishedAt ?? job.startedAt ?? job.createdAt,
  };
}

function transcriptDuration(transcript: Transcript): number | null {
  const ends = transcript.segments.map((segment) => segment.end);
  return ends.length === 0 ? null : Math.max(...ends);
}
