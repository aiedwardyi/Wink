import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

export const ROW_BUTTON = "relative inline-flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] [corner-shape:bevel] border border-hairline/40 px-2 text-[12px] font-normal text-ink-secondary transition-colors duration-100 not-disabled:hover:bg-raised-hover focus-visible:bg-raised-hover disabled:opacity-50 motion-reduce:transition-none [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2 [@media(pointer:coarse)]:after:inset-x-0";

export function Card({
  title,
  subtitle,
  band = false,
  children,
}: {
  title?: string;
  subtitle?: string;
  /** On a phone the card runs edge to edge inside the sheet, its rows in line with the close button, so a list page keeps its width. */
  band?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl bg-card p-4", band && "max-md:-mx-5 max-md:rounded-none max-md:px-3.5")}>
      {title && <div className="text-[15px] font-medium text-ink">{title}</div>}
      {subtitle && (
        <div className={cn("text-[13px] leading-relaxed text-ink-secondary", title && "mt-0.5")}>{subtitle}</div>
      )}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

/** The one empty or waiting state for a settings surface; the text says which. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div data-empty-state="" className="py-5 text-center text-[13px] leading-relaxed text-ink-secondary">{children}</div>;
}

/** A section header + body sharing one surface with its siblings, instead of a nested Card. */
export function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {subtitle && <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{subtitle}</div>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        onClick={() => void copy()}
        aria-label="Copy Command"
        className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
