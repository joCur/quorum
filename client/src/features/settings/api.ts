import { UserSettingsSchema, type UserSettings, type UserSettingsUpdate } from "@quorum/shared";
import { apiUrl } from "@/env";
import { toApiError } from "@/features/meetings/api";

/**
 * Client for the user's own preferences.
 *
 * Parsed with the shared schema rather than cast, like every other response: `shared/src/` is the
 * contract both sides compile against, and a server that has drifted from it should fail here
 * rather than put an unrecognized value in front of the user.
 */

interface RequestOptions {
  accessToken: string;
  signal?: AbortSignal | undefined;
}

async function call(
  path: string,
  options: RequestOptions & { method?: string; body?: unknown },
): Promise<Response> {
  const response = await fetch(apiUrl(path), {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await toApiError(response);
  return response;
}

export async function fetchUserSettings(options: RequestOptions): Promise<UserSettings> {
  const response = await call("/api/settings", options);
  return UserSettingsSchema.parse(await response.json());
}

/** Stores the named preferences and leaves the rest alone; answers with the settings as stored. */
export async function saveUserSettings(
  update: UserSettingsUpdate,
  options: RequestOptions,
): Promise<UserSettings> {
  const response = await call("/api/settings", { ...options, method: "PUT", body: update });
  return UserSettingsSchema.parse(await response.json());
}
