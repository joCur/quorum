import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteMeeting, listMeetings, MeetingApiError } from "@/features/meetings/api";
import { hasWorkInProgress, isInProgress } from "@/features/meetings/status";
import type { Meeting, MeetingStatus } from "@quorum/shared";

const ACCESS_TOKEN = "test-token";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "11111111-0000-4000-8000-000000000001",
    sessionId: "11111111-0000-4000-8000-000000000002",
    title: "Weekly sync",
    status: "ready",
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    createdAt: "2026-08-29T10:00:00.000Z",
    finalizedAt: "2026-08-29T10:05:00.000Z",
    durationSeconds: 42,
    language: "en",
    progress: null,
    hasAudio: true,
    failure: null,
    ...overrides,
  };
}

function respondWith(body: unknown, init: { status?: number } = {}): typeof fetch {
  const status = init.status ?? 200;
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("meeting API client", () => {
  it("parses the list through the shared schema", async () => {
    vi.stubGlobal("fetch", respondWith({ meetings: [meeting()] }));
    const meetings = await listMeetings({ accessToken: ACCESS_TOKEN });
    expect(meetings).toHaveLength(1);
    expect(meetings[0]?.title).toBe("Weekly sync");
  });

  it("sends the access token as a bearer token", async () => {
    const fetchSpy = respondWith({ meetings: [] });
    vi.stubGlobal("fetch", fetchSpy);
    await listMeetings({ accessToken: ACCESS_TOKEN });
    const init = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      RequestInit | undefined;
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("passes the search term as an encoded query parameter", async () => {
    const fetchSpy = respondWith({ meetings: [] });
    vi.stubGlobal("fetch", fetchSpy);
    await listMeetings({ accessToken: ACCESS_TOKEN, search: "weekly sync & retro" });
    const url = String((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(url).toContain("/api/meetings?q=weekly%20sync%20%26%20retro");
  });

  it("rejects a response that does not match the contract", async () => {
    // A server that drifts from shared/src must fail loudly rather than render half a meeting.
    vi.stubGlobal("fetch", respondWith({ meetings: [{ id: "not-a-uuid" }] }));
    await expect(listMeetings({ accessToken: ACCESS_TOKEN })).rejects.toThrow();
  });

  it("surfaces the server's error code", async () => {
    vi.stubGlobal(
      "fetch",
      respondWith(
        { error: "meeting_not_found", message: "No meeting with this id exists." },
        {
          status: 404,
        },
      ),
    );
    const failure = await deleteMeeting("11111111-0000-4000-8000-000000000001", {
      accessToken: ACCESS_TOKEN,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MeetingApiError);
    expect(failure).toMatchObject({ status: 404, code: "meeting_not_found" });
    expect((failure as MeetingApiError).isNotFound).toBe(true);
  });

  it("still reports a failure whose body is not our error shape", async () => {
    const html = vi.fn(
      async () => new Response("<html>502</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", html);

    const failure = await listMeetings({ accessToken: ACCESS_TOKEN }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ status: 502, code: "request_failed" });
  });
});

describe("polling decision", () => {
  const working: MeetingStatus[] = ["recording", "queued", "transcribing", "summarizing"];
  const settled: MeetingStatus[] = ["ready", "failed"];

  it.each(working)("keeps polling while a meeting is %s", (status) => {
    expect(isInProgress(status)).toBe(true);
    expect(hasWorkInProgress([meeting({ status })])).toBe(true);
  });

  it.each(settled)("stops polling once every meeting is %s", (status) => {
    expect(isInProgress(status)).toBe(false);
    expect(hasWorkInProgress([meeting({ status })])).toBe(false);
  });

  it("keeps polling when only one meeting of many is still working", () => {
    expect(
      hasWorkInProgress([meeting({ status: "ready" }), meeting({ status: "transcribing" })]),
    ).toBe(true);
  });

  it("does not poll an empty list", () => {
    expect(hasWorkInProgress([])).toBe(false);
  });
});
