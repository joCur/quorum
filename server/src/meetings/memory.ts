import type { Job, Meeting, Summary, Transcript } from "@quorum/shared";
import { deriveMeetingState, type StageState } from "./status.js";
import {
  DEFAULT_MEETING_LIMIT,
  MAX_MEETING_LIMIT,
  type ListMeetingsOptions,
  type MeetingDetailRow,
  type MeetingRecord,
  type MeetingScope,
  type MeetingStore,
} from "./repository.js";

interface StoredMeeting extends MeetingRecord {
  finalizedAt: string | null;
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
    });
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

  async close(): Promise<void> {
    // Nothing to release.
  }

  private toMeeting(meeting: StoredMeeting): Meeting {
    const pipeline = this.pipelines.get(meeting.meetingId) ?? {};
    const transcript = pipeline.transcript ?? null;
    const state = deriveMeetingState({
      finalizedAt: meeting.finalizedAt,
      transcribe: latestStage(pipeline.jobs, "transcribe"),
      summarize: latestStage(pipeline.jobs, "summarize"),
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

function latestStage(jobs: Job[] | undefined, type: Job["type"]): StageState | null {
  const matches = (jobs ?? []).filter((job) => job.type === type);
  const job = matches[matches.length - 1];
  if (!job) return null;
  return { status: job.status, progress: job.progress, error: job.error };
}

function transcriptDuration(transcript: Transcript): number | null {
  const ends = transcript.segments.map((segment) => segment.end);
  return ends.length === 0 ? null : Math.max(...ends);
}
