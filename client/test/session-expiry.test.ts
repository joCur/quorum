import { afterEach, describe, expect, it, vi } from "vitest";
import {
  locationTarget,
  onUnauthorized,
  reportUnauthorized,
  safeReturnTo,
} from "@/features/auth/session-expiry";
import { listMeetings, MeetingApiError } from "@/features/meetings/api";
import { listTemplates } from "@/features/templates/api";

const ACCESS_TOKEN = "test-token";

function refuse(status: number, body: unknown = { error: "unauthorized" }): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the shared session-expiry path", () => {
  it("reports a 401 from the meeting API", async () => {
    vi.stubGlobal("fetch", refuse(401));
    const seen = vi.fn();
    const stop = onUnauthorized(seen);

    await expect(listMeetings({ accessToken: ACCESS_TOKEN })).rejects.toBeInstanceOf(
      MeetingApiError,
    );
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reports a 401 from the template API too — one path, not one per client", async () => {
    vi.stubGlobal("fetch", refuse(401));
    const seen = vi.fn();
    const stop = onUnauthorized(seen);

    await expect(listTemplates({ accessToken: ACCESS_TOKEN })).rejects.toBeInstanceOf(
      MeetingApiError,
    );
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stays quiet for failures that are not about authentication", async () => {
    vi.stubGlobal("fetch", refuse(500, { error: "internal" }));
    const seen = vi.fn();
    const stop = onUnauthorized(seen);

    await expect(listMeetings({ accessToken: ACCESS_TOKEN })).rejects.toBeInstanceOf(
      MeetingApiError,
    );
    expect(seen).not.toHaveBeenCalled();
    stop();
  });

  it("marks a 401 as an authentication problem and nothing else as one", () => {
    expect(new MeetingApiError(401, "unauthorized", "").isUnauthorized).toBe(true);
    expect(new MeetingApiError(403, "forbidden", "").isUnauthorized).toBe(false);
    expect(new MeetingApiError(404, "not_found", "").isUnauthorized).toBe(false);
  });

  it("stops notifying an unsubscribed listener", () => {
    const seen = vi.fn();
    onUnauthorized(seen)();
    reportUnauthorized();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("the post-login return target", () => {
  it("keeps an in-app location whole", () => {
    expect(
      locationTarget({ pathname: "/meetings/abc", search: "?tab=summary", hash: "#t=12" }),
    ).toBe("/meetings/abc?tab=summary#t=12");
    expect(locationTarget({ pathname: "/settings" })).toBe("/settings");
  });

  it("accepts in-app paths", () => {
    expect(safeReturnTo("/meetings/abc?tab=summary")).toBe("/meetings/abc?tab=summary");
  });

  it("refuses anything that could redirect off this origin", () => {
    expect(safeReturnTo("//evil.example/steal")).toBeNull();
    expect(safeReturnTo("https://evil.example")).toBeNull();
    expect(safeReturnTo("meetings")).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo(42)).toBeNull();
  });
});
