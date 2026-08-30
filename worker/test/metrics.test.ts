import { describe, expect, it } from "vitest";
import { createWorkerMetrics, JOB_OUTCOMES } from "../src/observability/metrics.js";
import { startMetricsServer } from "../src/observability/server.js";

/** Process metrics are off here: they add noise and a scrape of them is not what is under test. */
function metrics() {
  return createWorkerMetrics({ collectProcessMetrics: false });
}

function sample(exposition: string, name: string, labels: string): number | undefined {
  const line = exposition
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}{${labels}}`));
  return line === undefined ? undefined : Number(line.split(" ").at(-1));
}

describe("worker job metrics", () => {
  it("counts an attempt under its queue and outcome", async () => {
    const subject = metrics();
    subject.observeJob({ queue: "transcribe", outcome: "succeeded", durationSeconds: 12 });
    subject.observeJob({ queue: "transcribe", outcome: "failed", durationSeconds: 3 });
    subject.observeJob({ queue: "summarize", outcome: "deadletter", durationSeconds: 1 });

    const exposition = await subject.render();

    expect(sample(exposition, "quorum_jobs_total", 'queue="transcribe",outcome="succeeded"')).toBe(
      1,
    );
    expect(sample(exposition, "quorum_jobs_total", 'queue="transcribe",outcome="failed"')).toBe(1);
    expect(sample(exposition, "quorum_jobs_total", 'queue="summarize",outcome="deadletter"')).toBe(
      1,
    );
  });

  it("pre-seeds every outcome series at zero", async () => {
    // Without the seed a failure-rate expression over a queue that has never failed returns
    // nothing at all, which reads as "no data" rather than "no failures".
    const exposition = await metrics().render();
    for (const outcome of JOB_OUTCOMES) {
      expect(
        sample(exposition, "quorum_jobs_total", `queue="transcribe",outcome="${outcome}"`),
      ).toBe(0);
    }
  });

  it("records durations in the histogram under the observed outcome", async () => {
    const subject = metrics();
    subject.observeJob({ queue: "transcribe", outcome: "succeeded", durationSeconds: 42 });

    const exposition = await subject.render();

    expect(
      sample(
        exposition,
        "quorum_job_duration_seconds_sum",
        'queue="transcribe",outcome="succeeded"',
      ),
    ).toBe(42);
    expect(
      sample(
        exposition,
        "quorum_job_duration_seconds_count",
        'queue="transcribe",outcome="succeeded"',
      ),
    ).toBe(1);
  });

  it("tracks in-flight attempts so a hung job is visible while it hangs", async () => {
    const subject = metrics();
    subject.jobStarted("transcribe");
    subject.jobStarted("transcribe");
    expect(sample(await subject.render(), "quorum_jobs_in_flight", 'queue="transcribe"')).toBe(2);

    subject.jobFinished("transcribe");
    expect(sample(await subject.render(), "quorum_jobs_in_flight", 'queue="transcribe"')).toBe(1);
  });
});

describe("worker metrics endpoint", () => {
  it("serves the exposition and a health probe", async () => {
    const subject = metrics();
    subject.observeJob({ queue: "summarize", outcome: "succeeded", durationSeconds: 2 });
    // Port 0 lets the OS pick a free one, so the test never collides with a running stack.
    const server = await startMetricsServer({ metrics: subject, port: 0, host: "127.0.0.1" });

    try {
      const scrape = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(scrape.status).toBe(200);
      expect(scrape.headers.get("content-type")).toContain("text/plain");
      expect(await scrape.text()).toContain("quorum_jobs_total");

      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", service: "quorum-worker" });

      const missing = await fetch(`http://127.0.0.1:${server.port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
