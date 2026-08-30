import {
  SummaryJobAcceptedSchema,
  SummaryTemplateListSchema,
  SummaryTemplateViewSchema,
  type SummaryJobAccepted,
  type SummaryTemplateDraft,
  type SummaryTemplateView,
} from "@quorum/shared";
import { apiUrl } from "@/env";
import { MeetingApiError } from "@/features/meetings/api";

/**
 * Client for the summary template API and for asking for a summary again.
 *
 * Responses are parsed with the shared schemas rather than cast, for the same reason the meeting
 * client does it: `shared/src/` is the contract both sides compile against, so a server that
 * drifts from it fails here, loudly, instead of rendering something half-defined.
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
  if (!response.ok) throw await toError(response);
  return response;
}

async function toError(response: Response): Promise<MeetingApiError> {
  let code = "request_failed";
  let message = response.statusText;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // Keep the status-derived defaults; a proxy may answer with something that is not our shape.
  }
  return new MeetingApiError(response.status, code, message);
}

export async function listTemplates(options: RequestOptions): Promise<SummaryTemplateView[]> {
  const response = await call("/api/summary-templates", options);
  return SummaryTemplateListSchema.parse(await response.json()).templates;
}

export async function createTemplate(
  draft: SummaryTemplateDraft,
  options: RequestOptions,
): Promise<SummaryTemplateView> {
  const response = await call("/api/summary-templates", {
    ...options,
    method: "POST",
    body: draft,
  });
  return SummaryTemplateViewSchema.parse(await response.json());
}

export async function updateTemplate(
  templateId: string,
  draft: SummaryTemplateDraft,
  options: RequestOptions,
): Promise<SummaryTemplateView> {
  const response = await call(`/api/summary-templates/${templateId}`, {
    ...options,
    method: "PUT",
    body: draft,
  });
  return SummaryTemplateViewSchema.parse(await response.json());
}

export async function deleteTemplate(templateId: string, options: RequestOptions): Promise<void> {
  await call(`/api/summary-templates/${templateId}`, { ...options, method: "DELETE" });
}

/** Makes this template the one new recordings are summarized with. */
export async function setDefaultTemplate(
  templateId: string,
  options: RequestOptions,
): Promise<void> {
  await call(`/api/summary-templates/${templateId}/default`, { ...options, method: "PUT" });
}

/** Gives up the choice, which puts new recordings back on the system template. */
export async function clearDefaultTemplate(options: RequestOptions): Promise<void> {
  await call("/api/summary-templates/default", { ...options, method: "DELETE" });
}

/** Asks for the meeting's active transcript to be summarized again with the chosen template. */
export async function regenerateSummary(
  meetingId: string,
  templateId: string,
  options: RequestOptions,
): Promise<SummaryJobAccepted> {
  const response = await call(`/api/meetings/${meetingId}/summaries`, {
    ...options,
    method: "POST",
    body: { templateId },
  });
  return SummaryJobAcceptedSchema.parse(await response.json());
}
