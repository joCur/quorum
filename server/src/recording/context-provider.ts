import type { RecordingContext, RecordingContextProvider } from "./types.js";

/**
 * Development-only context provider.
 *
 * It reads the tenant and user from request headers, which is acceptable only in
 * local development: it is refused unless `RECORDING_ALLOW_HEADER_AUTH=true` is
 * set explicitly. Production uses `JwtRecordingContextProvider`, which takes the
 * scope from the validated access token instead.
 */
export class HeaderRecordingContextProvider implements RecordingContextProvider {
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  async resolve(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<RecordingContext> {
    if (!this.enabled) {
      throw new UnauthorizedError("header-based recording auth is disabled");
    }
    const tenantId = single(request.headers["x-quorum-tenant-id"]);
    const userId = single(request.headers["x-quorum-user-id"]);
    if (!tenantId || !userId) {
      throw new UnauthorizedError("missing tenant or user header");
    }
    return { tenantId, userId };
  }
}

export class UnauthorizedError extends Error {}

function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
