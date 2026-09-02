import {
  generatedTitleUpdate,
  TRANSCRIPT_SCHEMA_VERSION,
  type Job,
  type Summary,
  type SummaryTemplate,
  type Transcript,
} from "@quorum/shared";
import type { JobScope, SaveSummaryResult, SummaryRepository } from "../src/db/repository.js";
import type {
  ChatCompletionClient,
  ChatCompletionResult,
  ChatMessage,
} from "../src/summary/chat-client.js";
import type { EnqueueSummaryInput, SummaryEnqueuer } from "../src/summary/enqueue.js";
import type { SummarizeJobPayload } from "../src/payload.js";
import { SYSTEM_SUMMARY_TEMPLATE } from "../src/summary/template.js";
import { segmentId } from "../src/ids.js";
import { MeetingGoneError } from "../src/errors.js";
import { MEETING_ID, SCOPE } from "./helpers.js";

export const TRANSCRIPT_ID = "55555555-5555-4555-8555-555555555555";
export const SUMMARIZE_JOB_ID = "66666666-6666-4666-8666-666666666666";

export function summarizeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: SUMMARIZE_JOB_ID,
    meetingId: MEETING_ID,
    type: "summarize",
    status: "queued",
    progress: null,
    error: null,
    resultId: null,
    createdAt: "2026-08-29T11:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

export function summarizePayload(
  overrides: Partial<SummarizeJobPayload> = {},
): SummarizeJobPayload {
  return {
    job: summarizeJob(),
    ...SCOPE,
    transcriptId: TRANSCRIPT_ID,
    templateId: SYSTEM_SUMMARY_TEMPLATE.id,
    ...overrides,
  };
}

/** A short transcript fixture with the shape the mapper produces. */
export function transcriptFixture(overrides: Partial<Transcript> = {}): Transcript {
  const texts = [
    "Right, let us start with the release date.",
    "I think we should ship on the fifteenth, the migration is done.",
    "Agreed, we ship on the fifteenth. Mara writes the release notes.",
    "One thing we did not settle: who runs the customer webinar?",
  ];
  return {
    id: TRANSCRIPT_ID,
    meetingId: MEETING_ID,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "small",
    modelVersion: "small",
    language: "en",
    recordedAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T10:35:00.000Z",
    speakers: [],
    segments: texts.map((text, index) => ({
      id: segmentId(TRANSCRIPT_ID, index),
      start: index * 15,
      end: index * 15 + 14,
      text,
      editedText: null,
      confidence: 0.9,
      speakerId: null,
      editedSpeakerId: null,
      language: null,
      words: null,
    })),
    ...overrides,
  };
}

/** The title the well-formed fixture answer suggests for the meeting. */
export const SUGGESTED_TITLE = "Release date and follow-up work";

/** A well-formed model answer for the system template. */
export const WELL_FORMED_ANSWER = JSON.stringify({
  title: SUGGESTED_TITLE,
  sections: [
    {
      sectionId: "overview",
      content: ["The team agreed on a release date and split the follow-up work."],
    },
    {
      sectionId: "key-points",
      content: ["The migration is finished.", "Release notes still open."],
    },
    { sectionId: "decisions", content: ["Ship on the fifteenth, because the migration is done."] },
    {
      sectionId: "action-items",
      content: [{ task: "Write the release notes", owner: "Mara", due: null }],
    },
    { sectionId: "open-questions", content: ["Who runs the customer webinar?"] },
  ],
});

export class FakeChatClient implements ChatCompletionClient {
  readonly calls: ChatMessage[][] = [];
  private index = 0;

  constructor(
    private readonly answers: (string | Error)[] = [WELL_FORMED_ANSWER],
    readonly model = "test/model",
    private readonly reportedModel: string | null = null,
  ) {}

  async complete(messages: ChatMessage[]): Promise<ChatCompletionResult> {
    this.calls.push(messages);
    const answer = this.answers[Math.min(this.index, this.answers.length - 1)];
    this.index += 1;
    if (answer instanceof Error) throw answer;
    return {
      content: answer ?? "",
      promptTokens: 1_000,
      completionTokens: 200,
      finishReason: "stop",
      model: this.reportedModel,
    };
  }
}

/** In-memory stand-in mirroring the two rules the real repository enforces. */
export class InMemorySummaryRepository implements SummaryRepository {
  readonly summaries = new Map<string, { summary: Summary; scope: JobScope }>();
  readonly byJob = new Map<string, string>();
  readonly jobStates: Job[] = [];
  readonly templates = new Map<string, SummaryTemplate>();
  readonly meetings = new Set<string>([MEETING_ID]);
  /** The title column of the meeting rows the server owns; absent means the row has none. */
  readonly meetingTitles = new Map<string, string | null>();
  transcripts = new Map<string, Transcript>();
  /**
   * Runs at the top of `saveSummary`, standing in for a delete that commits in
   * the last instant before the write.
   */
  onBeforeSaveSummary: (() => void) | null = null;

  constructor(
    transcripts: Transcript[] = [transcriptFixture()],
    templates: SummaryTemplate[] = [SYSTEM_SUMMARY_TEMPLATE],
  ) {
    for (const transcript of transcripts) this.transcripts.set(transcript.id, transcript);
    for (const template of templates) this.templates.set(template.id, template);
  }

  async seedTemplate(template: SummaryTemplate): Promise<void> {
    if (!this.templates.has(template.id)) this.templates.set(template.id, template);
  }

  async loadTemplate(templateId: string): Promise<SummaryTemplate | null> {
    return this.templates.get(templateId) ?? null;
  }

  async loadTranscript(transcriptId: string): Promise<Transcript | null> {
    return this.transcripts.get(transcriptId) ?? null;
  }

  async meetingExists(meetingId: string): Promise<boolean> {
    return this.meetings.has(meetingId);
  }

  async saveSummary(summary: Summary, scope: JobScope, jobId: string): Promise<SaveSummaryResult> {
    this.onBeforeSaveSummary?.();
    // The real repository checks and inserts in one transaction; here the
    // single-threaded fake gives the same guarantee for free.
    if (!this.meetings.has(summary.meetingId)) throw new MeetingGoneError(summary.meetingId);
    const existing = this.byJob.get(jobId);
    if (existing) return { summaryId: existing, created: false, appliedTitle: null };
    for (const entry of this.summaries.values()) {
      if (
        entry.summary.meetingId === summary.meetingId &&
        entry.summary.templateSnapshot.templateId === summary.templateSnapshot.templateId
      ) {
        entry.summary = { ...entry.summary, isActive: false };
      }
    }
    this.summaries.set(summary.id, { summary, scope });
    this.byJob.set(jobId, summary.id);
    // The name the summary suggests is decided and stored with it, in the same step the real
    // repository does it in one transaction.
    const title = generatedTitleUpdate(
      this.meetingTitles.get(summary.meetingId) ?? null,
      summary.generatedTitle,
    );
    if (title !== null) this.meetingTitles.set(summary.meetingId, title);
    return { summaryId: summary.id, created: true, appliedTitle: title };
  }

  async saveJob(job: Job): Promise<void> {
    // Mirrors the real repository: no job row is recorded for a meeting that is
    // no longer there.
    if (!this.meetings.has(job.meetingId)) return;
    this.jobStates.push(job);
  }

  get activeSummaries(): Summary[] {
    return [...this.summaries.values()]
      .map((entry) => entry.summary)
      .filter((summary) => summary.isActive);
  }
}

export class RecordingEnqueuer implements SummaryEnqueuer {
  readonly enqueued: EnqueueSummaryInput[] = [];

  constructor(private readonly failure?: Error) {}

  async enqueue(input: EnqueueSummaryInput): Promise<void> {
    if (this.failure) throw this.failure;
    this.enqueued.push(input);
  }
}
