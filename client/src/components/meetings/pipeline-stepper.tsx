import { AlertTriangle, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MeetingDetail } from "@quorum/shared";
import { pipelineSteps, type PipelineStep } from "@/features/meetings/pipeline";
import { cn } from "@/lib/utils";

/**
 * The processing readout (STATES.md §4).
 *
 * The active step shimmers and shows a determinate bar only when the worker actually reports a
 * number. There is no fake progress: a bar that moves on a timer would be the one thing on this
 * screen that is not true.
 */
export function PipelineStepper({ detail }: { detail: MeetingDetail }) {
  const { t } = useTranslation();
  const steps = pipelineSteps(detail);

  return (
    <ol
      className="flex flex-wrap items-center gap-2"
      aria-label={t("meeting.pipeline.label")}
      // Stage changes are useful but never urgent — they must not interrupt what the user is
      // reading (STATES.md §8).
      aria-live="polite"
    >
      {steps.map((step) => (
        <li key={step.stage}>
          <Step step={step} label={t(`meeting.pipeline.stages.${step.stage}`)} />
        </li>
      ))}
    </ol>
  );
}

function Step({ step, label }: { step: PipelineStep; label: string }) {
  return (
    <span
      className={cn(
        "relative flex items-center gap-1.5 overflow-hidden rounded-full px-3 py-1 text-xs font-medium",
        step.state === "done" && "bg-success-subtle text-success",
        step.state === "active" && "bg-info-subtle text-info",
        step.state === "failed" && "bg-destructive/10 text-destructive",
        step.state === "upcoming" && "border border-border text-muted-foreground",
      )}
    >
      {step.state === "done" ? (
        <Check aria-hidden="true" className="size-3.5 animate-pop-in" />
      ) : null}
      {step.state === "failed" ? <AlertTriangle aria-hidden="true" className="size-3.5" /> : null}
      {step.state === "active" ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-shimmer bg-[linear-gradient(90deg,transparent,hsl(var(--info)/0.15),transparent)] bg-[length:200%_100%] motion-reduce:animate-none"
        />
      ) : null}
      <span className="relative">{label}</span>
      {step.state === "active" && step.progress !== null ? (
        <span className="relative font-mono tabular-nums">{Math.round(step.progress * 100)}%</span>
      ) : null}
    </span>
  );
}
