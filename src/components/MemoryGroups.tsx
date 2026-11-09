import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Brain, Check, ChevronDown } from "lucide-react";
import type { AppState, Bot, Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { DETAILS_BOX, DetailsLabel } from "./BotDetailsRows";

import { memoryLineText, memoryTargetLine, recentLines } from "@/lib/memory-recent";
import { watchMemoryArrival } from "@/lib/memory-clean-events";
import { MemoryCleanTint, reducedMemoryMotion } from "./MemoryCleanMotion";

// the stamp memory-pass.ts appendNotes puts on every Auto notes line
const NOTED = /^\s*[-*+]\s+(.+?)\s+\(noted (\d{4})-(\d{2})-(\d{2})\)\s*$/;
const SHOWN = 5;

export function notedLines(text: string): Array<{ fact: string; at: Date }> {
  return text
    .split("\n")
    .flatMap((line) => {
      const m = NOTED.exec(line);
      return m ? [{ fact: m[1]!, at: new Date(Number(m[2]), Number(m[3]) - 1, Number(m[4])) }] : [];
    })
    .reverse()
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function MemoryGroup({ children }: { children?: ReactNode }) {
  return <section className={DETAILS_BOX}>{children}</section>;
}

/** A group that opens in place; its header sticks while open so the wheel can run through a long file. */
export type MemorySaveStatus = "idle" | "saving" | "saved" | "failed";

export function SaveState({ status }: { status: MemorySaveStatus }) {
  const { t } = useI18n();
  return (
    <span role="status" data-save-state={status} className={cn("inline-flex shrink-0 items-center gap-1 text-[12px] leading-4",
      status === "saving" && "animate-pulse text-ink-secondary motion-reduce:animate-none",
      status === "saved" && "animate-[fade-in_var(--motion-moderate)_var(--ease-entrance),fade-out_var(--motion-large)_var(--ease-exit)_1760ms_forwards] text-success motion-reduce:animate-none",
      status === "failed" && "text-danger")}>
      {status === "saved" && <Check size={12} aria-hidden="true" />}
      {status === "saving" ? t("bot.memorySaving") : status === "saved" ? t("bot.memorySaved") : status === "failed" ? t("bot.memoryNotSaved") : null}
    </span>
  );
}

export function MemoryFold({ title, hint, meta, status, open, onToggle, ref, children }: {
  title: string;
  hint: string;
  meta?: ReactNode;
  status?: ReactNode;
  open: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const header = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);
  // closing from deep in a long file would leave the reader below a section that is folding
  // away; its header stops sticking at once, so bring that back, with the box's 1px border
  useLayoutEffect(() => {
    if (wasOpen.current && !open) header.current?.scrollIntoView({ block: "nearest" });
    wasOpen.current = open;
  }, [open]);
  return (
    <section className={DETAILS_BOX}>
      <div ref={header} className={cn("scroll-my-px", open && "sticky top-0 z-10 border-b border-hairline/40 bg-card")}>
        <button ref={ref} type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-control/40 motion-reduce:transition-none">
          <div className="min-w-0 flex-1">
            <DetailsLabel label={title} hint={hint} />
          </div>
          {status}
          {meta && <span className="shrink-0 text-[12px] text-ink-secondary">{meta}</span>}
          <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      </div>
      {children}
    </section>
  );
}

export function MemoryFile({ text, loading, status, open, onToggle, ref, children }: {
  text: string;
  status?: ReactNode;
  loading: boolean;
  open: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const lines = text.split("\n").filter((line) => line.trim()).length;
  return (
    <MemoryFold
      ref={ref}
      title={t("bot.memoryFile")}
      hint={t("bot.memoryThisBotHelp")}
      meta={!loading && lines > 0 ? t(lines === 1 ? "bot.memoryFileLinesOne" : "bot.memoryFileLines", { count: lines }) : undefined}
      status={status}
      open={open}
      onToggle={onToggle}
    >
      {children}
    </MemoryFold>
  );
}

export interface MemoryTopic {
  name: string;
  bytes: number;
}

export const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

function RecentLine({ line, day, nonce, fresh }: { line: ReturnType<typeof recentLines>[number]; day: Intl.DateTimeFormat; nonce?: number; fresh: boolean }) {
  const row = useRef<HTMLLIElement>(null);
  const [arrived, setArrived] = useState(false);
  useEffect(() => { setArrived(fresh && !reducedMemoryMotion()); }, [fresh]);
  return (
    <li ref={row} className={`mc-target flex items-baseline justify-between gap-3 text-[13px] leading-relaxed text-ink${arrived ? " mc-in" : ""}`} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setArrived(false); }}>
      {nonce !== undefined && <MemoryCleanTint key={nonce} nonce={nonce} row={row} />}
      <span className="line-clamp-2 min-w-0 break-keep break-words" title={line.fact}>{line.fact}</span>
      <span className="shrink-0 text-[12px] text-ink-secondary">{day.format(line.at)}</span>
    </li>
  );
}

export function NotedLines({ text, messages = [], target, botId, active = true, limit }: { text: string; messages?: Message[]; target?: AppState["settingsMemoryTarget"]; botId?: string; active?: boolean; limit?: number }) {
  const { t, locale } = useI18n();
  const lines = recentLines(text, messages);
  const [fresh, setFresh] = useState<string[]>([]);
  const known = useRef(new Set<string>());
  known.current = new Set(lines.map((line) => line.line));
  useEffect(() => {
    if (!botId || !active) { setFresh([]); return; }
    return watchMemoryArrival(botId, (message) => {
      if (reducedMemoryMotion() || message.tool?.tidy) return;
      const incoming = (message.tool?.lines ?? [message.tool?.spoken ?? ""]).filter((saved) => ![...known.current].some((line) => line === saved.trimEnd() || memoryLineText(line).startsWith(saved.replace(/\.\.\.$/, "").trim())));
      setFresh((previous) => [...previous, ...incoming]);
    });
  }, [botId, active]);
  const targetLine = target && "line" in target.target ? memoryTargetLine(text, target.target.line, messages) : undefined;
  const shown = Math.max(limit ?? SHOWN, lines.findIndex((line) => line.line === targetLine) + 1);
  if (!lines.length) return null;
  const day = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" });
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {lines.slice(0, shown).map((line) => <RecentLine key={line.line} line={line} day={day} nonce={line.line === targetLine ? target?.nonce : undefined} fresh={fresh.some((saved) => memoryTargetLine(text, saved) === line.line)} />)}
      {limit === undefined && lines.length > shown && (
        <li className="text-[12px] text-ink-secondary">{t("bot.memoryMore", { count: lines.length - shown })}</li>
      )}
    </ul>
  );
}

export function MemoryEmpty() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 pb-6 pt-4 text-center text-ink-secondary">
      <Brain size={24} aria-hidden="true" />
      <div className="break-keep text-[13px] leading-relaxed">{t("bot.memoryEmpty")}</div>
    </div>
  );
}

export const currentTask = (bot: Bot) => {
  const packet = bot.tasks?.find((task) => task.threadId === bot.threadId)?.taskState;
  return packet?.goal.trim() ? packet : null;
};
