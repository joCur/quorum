import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { createServerMetrics, type QueueSnapshot } from "../src/observability/metrics.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";

function sample(exposition: string, name: string, labels = ""): number | undefined {
  const prefix = labels === "" ? name + " " : `${name}{${labels}}`;
  const line = exposition.split("\n").find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? undefined : Number(line.split(" ").at(-1));
}

function snapshotSource(...snapshots: (QueueSnapshot | Error)[]) {
  let index = 0;
  return {
    snapshot(): Promise<QueueSnapshot> {
      const next = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as QueueSnapshot);
    },
  };
}

describe("queue metrics", () => {
  it("exposes depth per queue and state, and the backlog age", async () => {
    const metrics = createServerMetrics({
      collectProcessMetrics: false,
      queues: snapshotSource({
        states: [
          { queue: "transcribe", state: "created", count: 3 },
          { queue: "transcribe", state: "active", count: 1 },
          { queue: "summarize", state: "failed", count: 2 },
        ],
        oldestPending: [{ queue: "transcribe", ageSeconds: 930 }],
      }),
    });

    const exposition = await metrics.render();

    expect(sample(exposition, "quorum_queue_jobs", 'queue="transcribe",state="created"')).toBe(3);
    expect(sample(exposition, "quorum_queue_jobs", 'queue="transcribe",state="active"')).toBe(1);
    expect(sample(exposition, "quorum_queue_jobs", 'queue="summarize",state="failed"')).toBe(2);
    expect(
      sample(exposition, "quorum_queue_oldest_pending_age_seconds", 'queue="transcribe"'),
    ).toBe(930);
  });

  it("drops a label combination that is no longer in the snapshot", async () => {
    // A drained queue has to stop reporting its old depth; a stale three would alert forever.
    const metrics = createServerMetrics({
      collectProcessMetrics: false,
      queues: snapshotSource(
        {
          states: [{ queue: "transcribe", state: "created", count: 3 }],
          oldestPending: [{ queue: "transcribe", ageSeconds: 930 }],
        },
        { states: [], oldestPending: [] },
      ),
    });

    await metrics.render();
    const exposition = await metrics.render();

    expect(
      sample(exposition, "quorum_queue_jobs", 'queue="transcribe",state="created"'),
    ).toBeUndefined();
    expect(sample(exposition, "quorum_queue_snapshot_failed")).toBe(0);
  });

  it("flags a failed snapshot instead of reporting an empty queue", async () => {
    const metrics = createServerMetrics({
      collectProcessMetrics: false,
      queues: snapshotSource(new Error("database is down")),
    });

    const exposition = await metrics.render();

    expect(sample(exposition, "quorum_queue_snapshot_failed")).toBe(1);
  });
});

describe("the /metrics route", () => {
  it("is served unauthenticated when a registry is supplied", async () => {
    const app = await buildServer({
      storage: new InMemoryRecordingStorage(),
      queue: new InMemoryJobQueue(),
      metrics: createServerMetrics({
        collectProcessMetrics: false,
        queues: snapshotSource({
          states: [{ queue: "transcribe", state: "created", count: 7 }],
          oldestPending: [],
        }),
      }),
    });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain('quorum_queue_jobs{queue="transcribe",state="created"} 7');

    await app.close();
  });

  it("does not exist on an instance built without metrics", async () => {
    const app = await buildServer({
      storage: new InMemoryRecordingStorage(),
      queue: new InMemoryJobQueue(),
    });

    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);

    await app.close();
  });
});
