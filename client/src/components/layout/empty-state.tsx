import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { IconTile } from "@/components/layout/icon-tile";

export function EmptyState({
  icon,
  accent = "honey",
  title,
  body,
  children,
}: {
  icon: LucideIcon;
  accent?: "honey" | "plum";
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-6 px-4 py-12 text-center">
      <IconTile icon={icon} accent={accent} className="animate-rise-in" />
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="animate-rise-in text-3xl font-bold leading-tight [animation-delay:30ms]">
          {title}
        </h2>
        <p className="animate-rise-in text-base text-muted-foreground [animation-delay:60ms]">
          {body}
        </p>
      </div>
      {children ? (
        <div className="flex animate-rise-in flex-col items-center gap-2 [animation-delay:90ms]">
          {children}
        </div>
      ) : null}
    </div>
  );
}
