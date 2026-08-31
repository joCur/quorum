import * as React from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  SectionFormat,
  SummaryOptions,
  SummaryTemplateDraft,
  TemplateSection,
} from "@quorum/shared";
import { Button } from "@/components/ui/button";
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

/** The uppercase micro-label that names a group of fields, as on the settings panel. */
const GROUP_LABEL = "text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground";

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
 *
 * A section is one heading plus what belongs under it, so it is laid out as one: position,
 * heading and format on a single row, the instruction underneath. Guidance that used to repeat
 * under every section is said once, above the list.
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
    <form className="flex max-w-2xl flex-col gap-6" onSubmit={submit} noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="template-name">{t("templates.editor.name")}</Label>
        <Input
          id="template-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={t("templates.editor.namePlaceholder")}
          aria-invalid={touched && nameError !== null}
          aria-describedby="template-name-help"
          className={cn("rounded-field", touched && nameError && "border-destructive")}
        />
        <p id="template-name-help" className="text-xs text-muted-foreground">
          {touched && nameError ? (
            <span className="text-destructive">{nameError}</span>
          ) : (
            t("templates.editor.nameHelp")
          )}
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className={cn(GROUP_LABEL, "mb-3")}>{t("templates.editor.style")}</legend>
        <div className="flex flex-wrap gap-3">
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
        <p className="text-xs text-muted-foreground">{t("templates.editor.languageHelp")}</p>
      </fieldset>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className={GROUP_LABEL}>{t("templates.editor.sections")}</h2>
          {/* Said once, above the list, instead of under every section: the same sentence
              repeated four times is noise rather than guidance. */}
          <p className="text-xs text-muted-foreground">{t("templates.editor.sectionsHelp")}</p>
        </div>

        {sections.map((section, index) => (
          <SectionCard
            key={section.id}
            section={section}
            index={index}
            total={sections.length}
            onChange={(changes) => patch(index, changes)}
            onMove={(direction) => setSections((current) => moveSection(current, index, direction))}
            onRemove={() => setSections((current) => current.filter((_, at) => at !== index))}
          />
        ))}

        <Button
          type="button"
          variant="ghost"
          className="w-fit rounded-pill border border-dashed border-input text-muted-foreground"
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

        {sectionsError ? <p className="text-sm text-destructive">{sectionsError}</p> : null}
      </div>

      <TemplatePreview sections={sections} options={options} />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="rounded-pill px-6" disabled={saving}>
          {saving ? t("templates.editor.saving") : t("templates.editor.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-pill px-5 text-muted-foreground"
          onClick={onCancel}
        >
          {t("common.cancel")}
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
    <section className="flex flex-col gap-2" aria-labelledby="template-preview-heading">
      <h2 id="template-preview-heading" className={GROUP_LABEL}>
        {t("templates.editor.preview")}
      </h2>
      <div className="flex flex-col gap-3 rounded-card border border-border bg-card p-4 md:p-5">
        {sections.map((section) => (
          <div key={section.id} className="flex flex-wrap items-baseline gap-2">
            {/* A honey underline rather than a bar beside the title — the mark the summary
                itself gives a section heading. */}
            <span className="font-display text-base font-bold shadow-[inset_0_-0.32em_0_hsl(var(--honey-subtle))]">
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
      </div>
    </section>
  );
}

/** One section: position, heading and format on one row, what belongs in it below. */
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

  return (
    <div className="flex animate-pop-in flex-col gap-2.5 rounded-card-sm border border-border bg-card p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* Where this section sits in the summary, in the mono figures the app uses for every
            other number. Decorative — the heading beside it names the section. */}
        <span
          aria-hidden="true"
          data-testid="section-number"
          className="w-5 shrink-0 font-mono text-xs tabular-figures text-honey-strong"
        >
          {String(index + 1).padStart(2, "0")}
        </span>
        <Input
          value={section.title}
          onChange={(event) => onChange({ title: event.target.value })}
          aria-label={t("templates.editor.sectionTitle")}
          className="h-10 min-w-40 flex-1 text-sm font-semibold"
        />
        <Select
          value={section.format}
          onChange={(event) => onChange({ format: event.target.value as SectionFormat })}
          aria-label={t("templates.editor.format")}
          className="h-10 w-auto text-sm"
        >
          {FORMATS.map((format) => (
            <option key={format} value={format}>
              {t(`templates.format.${format}`)}
            </option>
          ))}
        </Select>
        <div className="flex items-center">
          <SectionAction
            icon={ArrowUp}
            disabled={index === 0}
            label={t("templates.editor.moveUp", { section: section.title })}
            onClick={() => onMove(-1)}
          />
          <SectionAction
            icon={ArrowDown}
            disabled={index === total - 1}
            label={t("templates.editor.moveDown", { section: section.title })}
            onClick={() => onMove(1)}
          />
          <SectionAction
            icon={X}
            label={t("templates.editor.removeSection", { section: section.title })}
            className="hover:text-destructive"
            onClick={onRemove}
          />
        </div>
      </div>

      <Textarea
        rows={2}
        value={section.instruction}
        onChange={(event) => onChange({ instruction: event.target.value })}
        aria-label={t("templates.editor.instruction")}
        placeholder={t("templates.editor.instructionPlaceholder")}
        className="min-h-0 text-sm"
      />
    </div>
  );
}

/** One of the three controls that reorder or drop a section. */
function SectionAction({
  icon: Icon,
  label,
  disabled,
  className,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={disabled ?? false}
      onClick={onClick}
      aria-label={label}
      className={cn("size-10 rounded-pill text-muted-foreground", className)}
    >
      <Icon aria-hidden={true} className="size-4" />
    </Button>
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
    <div className="flex min-w-40 flex-1 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value}
        className="rounded-field"
        onChange={(event) => onChange(event.target.value as T)}
      >
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
