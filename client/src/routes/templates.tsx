import * as React from "react";
import { ListChecks, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SummaryTemplateDraft, SummaryTemplateView } from "@quorum/shared";
import { EmptyState } from "@/components/layout/empty-state";
import { DeleteTemplateDialog } from "@/components/templates/delete-template-dialog";
import { TemplateEditor } from "@/components/templates/template-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MeetingApiError } from "@/features/meetings/api";
import { useTemplates } from "@/features/templates/use-templates";
import { notify } from "@/lib/toast";

type Mode = { kind: "list" } | { kind: "create" } | { kind: "edit"; templateId: string };

const NEW_TEMPLATE_OPTIONS = {
  tone: "neutral",
  length: "standard",
  outputLanguage: "auto",
} as const;

/**
 * Templates screen: what the user can summarize with, and the editor for their own.
 *
 * The system template is listed but not editable — it is everybody's. Editing it would mean
 * changing other people's summaries, which is exactly what `basedOn` exists to avoid: a user
 * starts from it and shapes their own (ADR-004 §1).
 */
export function TemplatesRoute() {
  const { t } = useTranslation();
  const templates = useTemplates();
  const [mode, setMode] = React.useState<Mode>({ kind: "list" });
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // The template awaiting confirmation. Held by id rather than by object so a refreshed list
  // cannot leave the dialog pointing at a stale copy.
  const [confirming, setConfirming] = React.useState<string | null>(null);

  const system = templates.templates.find((view) => view.template.scope === "system") ?? null;
  const editing =
    mode.kind === "edit"
      ? (templates.templates.find((view) => view.template.id === mode.templateId) ?? null)
      : null;

  const save = (draft: SummaryTemplateDraft): void => {
    setSaveError(null);
    const written = editing
      ? templates.update(editing.template.id, draft)
      : templates.create(draft);
    void written
      .then(() => {
        setMode({ kind: "list" });
        // The editor closing back to the list is the only other signal that the save landed, and
        // an unchanged-looking list is a weak one — especially when editing, where the card the
        // user returns to may look exactly as it did before.
        notify.success(t("templates.saved"));
      })
      .catch((error: unknown) => {
        // The message stays on the editor, next to the fields the user would fix. A failed save
        // is not a transient notice: the work is still unsaved and has to remain in view.
        setSaveError(error instanceof MeetingApiError ? error.message : t("templates.saveFailed"));
      });
  };

  if (templates.status === "loading") return <TemplatesSkeleton />;

  if (templates.status === "error") {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-bold md:text-2xl">{t("templates.title")}</h1>
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6">
            <p className="text-muted-foreground">{t("templates.loadError")}</p>
            <Button variant="outline" onClick={templates.reload}>
              {t("common.retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode.kind !== "list") {
    // A template being edited resolves against its own base; a new one starts from the system
    // template, which is the useful default and the one the empty state promises.
    const baseSections = editing
      ? (templates.templates.find((view) => view.template.id === editing.template.basedOn)
          ?.resolvedSections ?? [])
      : (system?.resolvedSections ?? []);

    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-bold md:text-2xl">
          {editing ? editing.template.name : t("templates.create")}
        </h1>
        {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
        <TemplateEditor
          initialName={editing?.template.name ?? ""}
          initialSections={editing?.resolvedSections ?? baseSections}
          initialOptions={editing?.template.options ?? NEW_TEMPLATE_OPTIONS}
          baseSections={baseSections}
          basedOn={editing ? editing.template.basedOn : (system?.template.id ?? null)}
          saving={templates.saving}
          onCancel={() => {
            setSaveError(null);
            setMode({ kind: "list" });
          }}
          onSave={save}
        />
      </div>
    );
  }

  const own = templates.templates.filter((view) => view.editable);
  const doomed = templates.templates.find((view) => view.template.id === confirming) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold md:text-2xl">{t("templates.title")}</h1>
        <Button onClick={() => setMode({ kind: "create" })}>
          <Plus aria-hidden="true" className="size-4" />
          {t("templates.create")}
        </Button>
      </div>

      {own.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          accent="plum"
          title={t("templates.empty.title")}
          body={t("templates.empty.body")}
        >
          <Button onClick={() => setMode({ kind: "create" })}>{t("templates.create")}</Button>
        </EmptyState>
      ) : null}

      <div className="flex flex-col gap-3">
        {templates.templates.map((view) => (
          <TemplateCard
            key={view.template.id}
            view={view}
            onEdit={() => setMode({ kind: "edit", templateId: view.template.id })}
            onDelete={() => setConfirming(view.template.id)}
            onToggleDefault={() => {
              // Unsetting is not "no default" — it is falling back to the system template, which
              // is what the list then marks. The user is never left without one.
              void templates.chooseDefault(view.isDefault ? null : view.template.id);
            }}
          />
        ))}
      </div>

      <DeleteTemplateDialog
        open={doomed !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        templateName={doomed?.template.name ?? ""}
        onConfirm={() => {
          const templateId = confirming;
          setConfirming(null);
          if (templateId) void templates.remove(templateId);
        }}
      />
    </div>
  );
}

function TemplateCard({
  view,
  onEdit,
  onDelete,
  onToggleDefault,
}: {
  view: SummaryTemplateView;
  onEdit: () => void;
  onDelete: () => void;
  onToggleDefault: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Card data-testid="template-card">
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            {/* Transitional: `plum` no longer exists in v2 and resolves to honey through the
                Tailwind color mapping. This marker becomes a honey underline when the
                templates area ticket restyles this screen. */}
            <span aria-hidden="true" className="h-5 w-1 rounded-full bg-plum" />
            <span className="truncate">{view.template.name}</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("templates.sectionCount", { count: view.resolvedSections.length })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view.isDefault ? <Badge variant="plum">{t("templates.default")}</Badge> : null}
          {view.editable ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleDefault}
                aria-pressed={view.isDefault}
                aria-label={t(view.isDefault ? "templates.unsetDefault" : "templates.setDefault", {
                  template: view.template.name,
                })}
              >
                <Star aria-hidden="true" className={view.isDefault ? "fill-current" : undefined} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onEdit}
                aria-label={t("templates.edit", { template: view.template.name })}
              >
                <Pencil aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onDelete}
                aria-label={t("templates.delete", { template: view.template.name })}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </>
          ) : (
            <Badge>{t("templates.system")}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {view.resolvedSections.map((section) => (
            <li key={section.id}>{section.title}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function TemplatesSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-7 w-40" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
}
