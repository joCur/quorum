import * as React from "react";
import type { SummaryTemplateDraft, SummaryTemplateView } from "@quorum/shared";
import { useAuth } from "@/features/auth/auth-provider";
import { MeetingApiError } from "@/features/meetings/api";
import {
  clearDefaultTemplate,
  createTemplate,
  deleteTemplate,
  listTemplates,
  setDefaultTemplate,
  updateTemplate,
} from "@/features/templates/api";

export type TemplatesStatus = "loading" | "ready" | "error";

export interface TemplatesState {
  templates: SummaryTemplateView[];
  status: TemplatesStatus;
  errorCode: string | null;
  saving: boolean;
  reload: () => void;
  create: (draft: SummaryTemplateDraft) => Promise<SummaryTemplateView>;
  update: (templateId: string, draft: SummaryTemplateDraft) => Promise<SummaryTemplateView>;
  remove: (templateId: string) => Promise<void>;
  /**
   * Chooses the template new recordings are summarized with. `null` gives the
   * choice up, which is the same state as never having made one: the system
   * template.
   */
  chooseDefault: (templateId: string | null) => Promise<void>;
}

/**
 * The caller's templates, loaded once and refreshed after every write.
 *
 * There is no polling here, unlike the meeting list: a template only changes when this user
 * changes it, so re-reading on a timer would be asking a question whose answer cannot have moved.
 */
export function useTemplates(): TemplatesState {
  const { accessToken } = useAuth();
  const [templates, setTemplates] = React.useState<SummaryTemplateView[]>([]);
  const [status, setStatus] = React.useState<TemplatesStatus>("loading");
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    let active = true;

    void (async () => {
      try {
        const next = await listTemplates({ accessToken, signal: controller.signal });
        if (!active) return;
        setTemplates(next);
        setStatus("ready");
        setErrorCode(null);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        // A 401 is not this screen's problem: the shared session-expiry path is already renewing
        // the token or routing into the login flow, so the screen keeps its last honest state
        // instead of blaming the data.
        if (error instanceof MeetingApiError && error.isUnauthorized) return;
        setStatus("error");
        setErrorCode(error instanceof MeetingApiError ? error.code : "network");
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [accessToken, reloadToken]);

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), []);

  /** Writes go through here so every one of them refreshes the list it just changed. */
  const write = React.useCallback(
    async <T>(action: (token: string) => Promise<T>): Promise<T> => {
      if (!accessToken) throw new MeetingApiError(401, "missing_token", "Not signed in.");
      setSaving(true);
      try {
        const result = await action(accessToken);
        setReloadToken((token) => token + 1);
        return result;
      } finally {
        setSaving(false);
      }
    },
    [accessToken],
  );

  const create = React.useCallback(
    (draft: SummaryTemplateDraft) =>
      write((token) => createTemplate(draft, { accessToken: token })),
    [write],
  );

  const update = React.useCallback(
    (templateId: string, draft: SummaryTemplateDraft) =>
      write((token) => updateTemplate(templateId, draft, { accessToken: token })),
    [write],
  );

  const remove = React.useCallback(
    (templateId: string) => write((token) => deleteTemplate(templateId, { accessToken: token })),
    [write],
  );

  const chooseDefault = React.useCallback(
    (templateId: string | null) =>
      write((token) =>
        templateId === null
          ? clearDefaultTemplate({ accessToken: token })
          : setDefaultTemplate(templateId, { accessToken: token }),
      ),
    [write],
  );

  return { templates, status, errorCode, saving, reload, create, update, remove, chooseDefault };
}
