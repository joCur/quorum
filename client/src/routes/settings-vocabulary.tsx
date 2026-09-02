import * as React from "react";
import { ArrowLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  MAX_VOCABULARY_TERMS as MAX_TERMS,
  MAX_VOCABULARY_TERM_LENGTH as MAX_TERM_LENGTH,
  canAddVocabularyTerm,
} from "@quorum/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUserSettings } from "@/features/settings/use-user-settings";
import { notify } from "@/lib/toast";

/**
 * The user's custom vocabulary, managed as a flat list.
 *
 * The screen refuses a term that would not fit rather than storing it, because the backend
 * enforces the prompt budget by silently discarding the overflow — anything accepted here that
 * did not fit would simply never be sent. Both caps can be the one that is full, so the refusal
 * says which.
 */
export function SettingsVocabularyRoute() {
  const { t } = useTranslation();
  const settings = useUserSettings();
  const [draft, setDraft] = React.useState("");
  const terms = settings.settings.vocabulary;
  const busy = settings.status === "loading" || settings.saving;

  function add(event: React.FormEvent) {
    event.preventDefault();
    const attempt = canAddVocabularyTerm(terms, draft);
    if (!attempt.ok) {
      // Enter on an empty field is not a mistake worth reporting.
      if (attempt.reason !== "empty") {
        notify.failure(t(`settings.vocabulary.rejected.${attempt.reason}`, { max: MAX_TERMS }));
      }
      return;
    }
    // Cleared before the save resolves, so the field cannot be submitted a second time.
    setDraft("");
    void settings.saveVocabulary([...terms, attempt.term]).catch(() => {
      // Restored only into an untouched field: a slow failure must not overwrite the next term.
      setDraft((current) => (current === "" ? attempt.term : current));
      notify.failure(t("settings.vocabulary.saveFailed"));
    });
  }

  function remove(term: string) {
    void settings
      .saveVocabulary(terms.filter((stored) => stored !== term))
      .catch(() => notify.failure(t("settings.vocabulary.saveFailed")));
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="flex w-fit items-center gap-1 rounded-sm py-1 text-[13.5px] font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("settings.vocabulary.back")}
        </Link>

        <h1 className="text-display-lg">{t("settings.vocabulary.title")}</h1>
      </div>

      <p className="max-w-prose text-sm text-muted-foreground">{t("settings.vocabulary.help")}</p>

      <form className="flex max-w-md gap-2" onSubmit={add}>
        <Label htmlFor="vocabulary-term" className="sr-only">
          {t("settings.vocabulary.label")}
        </Label>
        <Input
          id="vocabulary-term"
          value={draft}
          disabled={busy}
          maxLength={MAX_TERM_LENGTH}
          placeholder={t("settings.vocabulary.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy || draft.trim() === ""}>
          {t("settings.vocabulary.add")}
        </Button>
      </form>

      {terms.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {terms.map((term) => (
            <li
              key={term}
              className="flex items-center gap-1 rounded-full border border-input py-1.5 pl-3.5 pr-1.5 text-sm"
            >
              <span>{term}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(term)}
                aria-label={t("settings.vocabulary.remove", { term })}
                className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors duration-micro hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-sm text-muted-foreground tabular-figures">
        {t("settings.vocabulary.count", { count: terms.length, max: MAX_TERMS })}
      </p>
    </div>
  );
}
