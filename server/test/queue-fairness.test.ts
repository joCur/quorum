import { describe, expect, it } from "vitest";
import { MAX_FAIRNESS_PENALTY, fairnessPriority } from "../src/recording/queue/fairness.js";
import {
  PgBossJobQueue,
  SUMMARIZE_QUEUE,
  TRANSCRIBE_QUEUE,
  type PendingJobCounter,
} from "../src/recording/queue/pg-boss.js";

/** Records what would have gone to pg-boss, so the enqueue decision is assertable. */
class FakeBoss {
  readonly sent: Array<{ queue: string; options: { priority?: number } }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createQueue(): Promise<void> {}
  async send(queue: string, _data: unknown, options: { priority?: number }): Promise<string> {
    this.sent.push({ queue, options });
    return "job-id";
  }
}

function queueWith(counter: PendingJobCounter): { queue: PgBossJobQueue; boss: FakeBoss } {
  const boss = new FakeBoss();
  return {
    queue: new PgBossJobQueue(
      boss as unknown as ConstructorParameters<typeof PgBossJobQueue>[0],
      counter,
    ),
    boss,
  };
}

const JOB = {
  jobId: "11111111-1111-4111-8111-111111111111",
  meetingId: "22222222-2222-4222-8222-222222222222",
  tenantId: "tenant-a",
  userId: "user-1",
  sessionId: "33333333-3333-4333-8333-333333333333",
  language: null,
  vocabulary: [],
};

describe("fairness priority", () => {
  it("gives a user with nothing waiting the neutral priority", () => {
    expect(fairnessPriority(0)).toBe(0);
    // A negative or nonsensical count can only come from a broken counter; it must not become a
    // *bonus* that jumps the queue.
    expect(fairnessPriority(-5)).toBe(0);
    expect(fairnessPriority(Number.NaN)).toBe(0);
  });

  it("ranks each further job of the same user behind the previous one", () => {
    expect(fairnessPriority(1)).toBe(-1);
    expect(fairnessPriority(2)).toBe(-2);
    // The point of the whole mechanism: a newcomer outranks somebody with a backlog.
    expect(fairnessPriority(0)).toBeGreaterThan(fairnessPriority(20));
  });

  it("clamps a pathological backlog instead of running off the scale", () => {
    expect(fairnessPriority(MAX_FAIRNESS_PENALTY + 5_000)).toBe(-MAX_FAIRNESS_PENALTY);
  });
});

describe("enqueue decision", () => {
  it("enqueues a first transcription at the neutral priority", async () => {
    const { queue, boss } = queueWith(async () => 0);
    await queue.enqueueTranscribe(JOB);
    expect(boss.sent[0]?.queue).toBe(TRANSCRIBE_QUEUE);
    expect(boss.sent[0]?.options.priority).toBe(0);
  });

  it("penalizes a user who already has work waiting", async () => {
    const { queue, boss } = queueWith(async () => 4);
    await queue.enqueueTranscribe(JOB);
    expect(boss.sent[0]?.options.priority).toBe(-4);
  });

  it("counts each queue separately", async () => {
    const seen: string[] = [];
    const { queue, boss } = queueWith(async (name) => {
      seen.push(name);
      return 2;
    });
    await queue.enqueueSummarize({
      ...JOB,
      transcriptId: "44444444-4444-4444-8444-444444444444",
      templateId: "system",
      createdAt: "2026-08-29T10:00:00.000Z",
    });
    expect(seen).toEqual([SUMMARIZE_QUEUE]);
    expect(boss.sent[0]?.options.priority).toBe(-2);
  });

  it("still enqueues when the count cannot be taken", async () => {
    const { queue, boss } = queueWith(async () => {
      throw new Error("database unavailable");
    });
    await queue.enqueueTranscribe(JOB);
    // Losing the transcription of a finished recording would be far worse than losing fairness
    // for one job.
    expect(boss.sent).toHaveLength(1);
    expect(boss.sent[0]?.options.priority).toBe(0);
  });
});
