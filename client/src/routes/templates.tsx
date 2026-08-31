import * as React from "react";
import { ListChecks, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SummaryTemplateDraft, SummaryTemplateView } from "@quorum/shared";
import { EmptyState } from "@/components/layout/empty-state";
import { DeleteTemplateDialog } from "@/components/templates/delete-template-dialog";
import { TemplateEditor } from "@/components/templates/template-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MeetingApiError } from "@/features/meetings/api";
import { useTemplates } from "@/features/templates/use-templates";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";

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
          accent="honey"
          title={t("templates.empty.title")}
          body={t("templates.empty.body")}
        >
          <Button onClick={() => setMode({ kind: "create" })}>{t("templates.create")}</Button>
        </EmptyState>
      ) : null}

      {/* Cards side by side from the width where a second column still leaves each one readable.
          The lower bound is `min(100%, 300px)` rather than a flat 300px so a 320px-wide phone
          gets one full-width column instead of a card wider than the screen. */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
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
    <Card data-testid="template-card" className="flex h-full flex-col gap-3 p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="min-w-0 break-words text-base">{view.template.name}</CardTitle>
        {view.isDefault ? (
          <Badge variant="honey" data-testid="template-default-badge">
            {t("templates.default")}
          </Badge>
        ) : null}
        {view.editable ? null : <Badge>{t("templates.system")}</Badge>}
      </div>

      {/* The sections in the order a summary will carry them. Numbering them is the point: a
          template is a sequence, and the chip row it replaces said nothing about order. */}
      <ol
        aria-label={t("templates.sectionCount", { count: view.resolvedSections.length })}
        className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground marker:font-mono marker:text-xs marker:text-honey-strong"
      >
        {view.resolvedSections.map((section) => (
          <li key={section.id}>{section.title}</li>
        ))}
      </ol>

      {view.editable ? (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {/* The pills say what they do. Each accessible name starts with the word on the pill,
              so speech input can reach a control by the label the user can see (WCAG 2.5.3). */}
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "rounded-full",
              view.isDefault && "border-honey-strong bg-honey-subtle text-honey-strong",
            )}
            onClick={onToggleDefault}
            aria-pressed={view.isDefault}
            aria-label={t(view.isDefault ? "templates.unsetDefault" : "templates.setDefault", {
              template: view.template.name,
            })}
          >
            <Star aria-hidden="true" className={cn("size-4", view.isDefault && "fill-current")} />
            {t("templates.default")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={onEdit}
            aria-label={t("templates.edit", { template: view.template.name })}
          >
            <Pencil aria-hidden="true" className="size-4" />
            {t("templates.editShort")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full px-3 hover:text-destructive"
            onClick={onDelete}
            aria-label={t("templates.delete", { template: view.template.name })}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function TemplatesSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-7 w-40" />
      {/* Same grid as the real list, so nothing reflows when the templates arrive. */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
