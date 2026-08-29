import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresRepository } from "../src/db/repository.js";
import { OpenAiChatClient } from "../src/summary/chat-client.js";
import { runSummarizeJob } from "../src/summary/handler.js";
import { SYSTEM_SUMMARY_TEMPLATE } from "../src/summary/template.js";
import { silentLogger } from "./helpers.js";
import { summarizeJob, transcriptFixture } from "./summary-helpers.js";

/**
 * Opt-in integration test against a real OpenAI-compatible summary endpoint and
 * a real PostgreSQL. It is the only check that the provider abstraction of
 * ADR-005 actually holds against a live backend — the unit tests mock the HTTP
 * layer and therefore cannot tell whether a given router accepts our request.
 *
 *   docker compose up -d postgres
 *   QUORUM_SUMMARY_INTEGRATION=1 SUMMARY_API_KEY=... SUMMARY_MODEL=... \
 *     pnpm vitest run worker/test/summary-integration.test.ts
 *
 * Excluded from the default run because it costs money, needs a network and a
 * database, and is non-deterministic by nature: it asserts on the *structure*
 * of the answer, never on its wording.
 */
const enabled = process.env.QUORUM_SUMMARY_INTEGRATION === "1";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://quorum:CHANGE_ME@127.0.0.1:5432/quorum";
const summaryBaseUrl = process.env.SUMMARY_BASE_URL ?? "https://openrouter.ai/api/v1";
const summaryModel = process.env.SUMMARY_MODEL ?? "openai/gpt-4o-mini";

describe.skipIf(!enabled)("summary worker against a live backend", () => {
  it("summarizes a transcript into the template's sections and stays idempotent", async () => {
    const tenantId = `tenant-${Date.now()}`;
    const meetingId = randomUUID();
    const transcriptId = randomUUID();
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const scope = { tenantId, userId: "user-1", sessionId };

    const repository = new PostgresRepository(databaseUrl);
    await repository.migrate();
    await repository.seedTemplate(SYSTEM_SUMMARY_TEMPLATE);

    const transcript = transcriptFixture({ id: transcriptId, meetingId });
    await repository.saveTranscript(transcript, scope, randomUUID());

    const deps = {
      chat: new OpenAiChatClient({
        baseUrl: summaryBaseUrl,
        model: summaryModel,
        apiKey: process.env.SUMMARY_API_KEY,
      }),
      repository,
      logger: silentLogger,
      maxInputTokens: 14_000,
    };
    const payload = {
      job: summarizeJob({ id: jobId, meetingId }),
      ...scope,
      transcriptId,
      templateId: SYSTEM_SUMMARY_TEMPLATE.id,
    };

    try {
      const first = await runSummarizeJob(payload, 0, deps);
      expect(first.created).toBe(true);
      // Structure, not wording: the model's prose is not ours to assert on.
      expect(first.sectionCount).toBe(SYSTEM_SUMMARY_TEMPLATE.sections.length);

      // A crash mid-job means the queue hands the same job out again — and a
      // second paid call must not produce a second summary.
      const replay = await runSummarizeJob(payload, 1, deps);
      expect(replay.created).toBe(false);
      expect(replay.summaryId).toBe(first.summaryId);
    } finally {
      await repository.close();
    }
  }, 300_000);
});
