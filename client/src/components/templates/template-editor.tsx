import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  SectionFormat,
  SummaryOptions,
  SummaryTemplateDraft,
  TemplateSection,
} from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { moveSection, newSectionId, toDraft } from "@/features/templates/draft";
import { cn } from "@/lib/utils";

const FORMATS: readonly SectionFormat[] = ["prose", "bullets", "table"];
const TONES: readonly SummaryOptions["tone"][] = ["neutral", "formal", "casual"];
const LENGTHS: readonly SummaryOptions["length"][] = ["brief", "standard", "detailed"];

/**
 * Output languages offered in the picker. `auto` is first and is the default: following the
 * recording is what people mean almost every time, and it is the setting that survives a meeting
 * held in a language nobody thought to configure for.
 */
const LANGUAGES = ["auto", "en", "de"] as const;

export interface TemplateEditorProps {
  /** Name of the template being edited, empty for a new one. */
  initialName: string;
  /** Sections the template resolves to today — the list the user actually edits. */
  initialSections: readonly TemplateSection[];
  initialOptions: SummaryOptions;
  /** Sections of the template this one inherits from; empty when it inherits from nothing. */
  baseSections: readonly TemplateSection[];
  basedOn: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (draft: SummaryTemplateDraft) => void;
}

/**
 * Editor for one template (COMPONENTS.md §8).
 *
 * The user edits a flat, ordered list of sections. What gets stored is the set of overrides that
 * produces that list from the base template — `features/templates/draft.ts` does the conversion,
 * so this component never has to think about inheritance.
 */
export function TemplateEditor({
  initialName,
  initialSections,
  initialOptions,
  baseSections,
  basedOn,
  saving,
  onCancel,
  onSave,
}: TemplateEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(initialName);
  const [sections, setSections] = React.useState<TemplateSection[]>([...initialSections]);
  const [options, setOptions] = React.useState<SummaryOptions>(initialOptions);
  const [touched, setTouched] = React.useState(false);

  const nameError = name.trim() === "" ? t("templates.editor.nameRequired") : null;
  const sectionsError = sections.length === 0 ? t("templates.editor.sectionsRequired") : null;

  const patch = (index: number, changes: Partial<TemplateSection>): void => {
    setSections((current) =>
      current.map((section, at) => (at === index ? { ...section, ...changes } : section)),
    );
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (nameError || sectionsError) return;
    onSave(toDraft({ name, basedOn, baseSections, sections, options }));
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="template-name">{t("templates.editor.name")}</Label>
        <Input
          id="template-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && nameError !== null}
          aria-describedby="template-name-help"
          className={cn(touched && nameError && "border-destructive")}
        />
        <p id="template-name-help" className="text-sm text-muted-foreground">
          {touched && nameError ? (
            <span className="text-destructive">{nameError}</span>
          ) : (
            t("templates.editor.nameHelp")
          )}
        </p>
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium">{t("templates.editor.style")}</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <OptionSelect
            id="template-tone"
            label={t("templates.editor.tone")}
            value={options.tone}
            values={TONES}
            render={(value) => t(`templates.tone.${value}`)}
            onChange={(tone) => setOptions((current) => ({ ...current, tone }))}
          />
          <OptionSelect
            id="template-length"
            label={t("templates.editor.length")}
            value={options.length}
            values={LENGTHS}
            render={(value) => t(`templates.length.${value}`)}
            onChange={(length) => setOptions((current) => ({ ...current, length }))}
          />
          <OptionSelect
            id="template-language"
            label={t("templates.editor.language")}
            value={options.outputLanguage}
            values={languageChoices(options.outputLanguage)}
            render={(value) => t(`templates.language.${value}`, { defaultValue: value })}
            onChange={(outputLanguage) => setOptions((current) => ({ ...current, outputLanguage }))}
          />
        </div>
        <p className="text-sm text-muted-foreground">{t("templates.editor.languageHelp")}</p>
      </fieldset>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t("templates.editor.sections")}</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setSections((current) => [
                ...current,
                {
                  id: newSectionId(),
                  title: t("templates.editor.newSectionTitle"),
                  instruction: "",
                  format: "bullets",
                },
              ])
            }
          >
            <Plus aria-hidden="true" className="size-4" />
            {t("templates.editor.addSection")}
          </Button>
        </div>

        {sectionsError ? (
          <p className="text-sm text-destructive">{sectionsError}</p>
        ) : (
          sections.map((section, index) => (
            <SectionCard
              key={section.id}
              section={section}
              index={index}
              total={sections.length}
              onChange={(changes) => patch(index, changes)}
              onMove={(direction) =>
                setSections((current) => moveSection(current, index, direction))
              }
              onRemove={() => setSections((current) => current.filter((_, at) => at !== index))}
            />
          ))
        )}
      </div>

      <TemplatePreview sections={sections} options={options} />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? t("templates.editor.saving") : t("templates.editor.save")}
        </Button>
      </div>
    </form>
  );
}

/**
 * What a summary made with this template will be shaped like, live as the form is edited.
 *
 * It shows the section headings and their formats, not invented content: a preview that made up
 * bullet points would be a promise about the model's output that nothing here can keep.
 */
function TemplatePreview({
  sections,
  options,
}: {
  sections: readonly TemplateSection[];
  options: SummaryOptions;
}) {
  const { t } = useTranslation();
  if (sections.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="template-preview-heading">
      <h2 id="template-preview-heading" className="text-sm font-medium">
        {t("templates.editor.preview")}
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          {sections.map((section) => (
            <div key={section.id} className="flex items-baseline gap-2">
              <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-full bg-honey-strong" />
              <span className="text-base font-semibold">
                {section.title.trim() || t("templates.editor.untitledSection")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(`templates.format.${section.format}`)}
              </span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {t("templates.editor.previewMeta", {
              tone: t(`templates.tone.${options.tone}`),
              length: t(`templates.length.${options.length}`),
              language: t(`templates.language.${options.outputLanguage}`, {
                defaultValue: options.outputLanguage,
              }),
            })}
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

/** One section, as a card with the accent marker that marks the summary side of the product. */
function SectionCard({
  section,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  section: TemplateSection;
  index: number;
  total: number;
  onChange: (changes: Partial<TemplateSection>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const titleId = `section-${section.id}-title`;
  const instructionId = `section-${section.id}-instruction`;
  const formatId = `section-${section.id}-format`;

  return (
    <Card className="animate-pop-in overflow-hidden">
      <div className="flex">
        <span aria-hidden="true" className="w-1 shrink-0 bg-honey-subtle" />
        <CardContent className="flex flex-1 flex-col gap-4 pt-6">
          <div className="flex items-end gap-2">
            {/* Where this section sits in the summary, in the mono figures the app uses for
                every other number. Decorative — the fields beside it already name the section. */}
            <span
              aria-hidden="true"
              data-testid="section-number"
              className="pb-2.5 font-mono text-xs tabular-figures text-honey-strong"
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor={titleId}>{t("templates.editor.sectionTitle")}</Label>
              <Input
                id={titleId}
                value={section.title}
                onChange={(event) => onChange({ title: event.target.value })}
              />
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={index === 0}
                onClick={() => onMove(-1)}
                aria-label={t("templates.editor.moveUp", { section: section.title })}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={index === total - 1}
                onClick={() => onMove(1)}
                aria-label={t("templates.editor.moveDown", { section: section.title })}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onRemove}
                aria-label={t("templates.editor.removeSection", { section: section.title })}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={instructionId}>{t("templates.editor.instruction")}</Label>
            <Textarea
              id={instructionId}
              value={section.instruction}
              onChange={(event) => onChange({ instruction: event.target.value })}
              aria-describedby={`${instructionId}-help`}
            />
            <p id={`${instructionId}-help`} className="text-sm text-muted-foreground">
              {t("templates.editor.instructionHelp")}
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:max-w-xs">
            <Label htmlFor={formatId}>{t("templates.editor.format")}</Label>
            <Select
              id={formatId}
              value={section.format}
              onChange={(event) => onChange({ format: event.target.value as SectionFormat })}
            >
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`templates.format.${format}`)}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </div>
    </Card>
  );
}

function OptionSelect<T extends string>({
  id,
  label,
  value,
  values,
  render,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  values: readonly T[];
  render: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {values.map((option) => (
          <option key={option} value={option}>
            {render(option)}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * The picker offers the common cases, but the field accepts any BCP-47 tag. A stored language the
 * picker does not list is added to the choices rather than silently rewritten — opening a template
 * must never change what it says.
 */
function languageChoices(outputLanguage: string): readonly string[] {
  return (LANGUAGES as readonly string[]).includes(outputLanguage)
    ? LANGUAGES
    : [...LANGUAGES, outputLanguage];
}
