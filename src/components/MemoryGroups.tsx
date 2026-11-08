import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Brain, ChevronDown } from "lucide-react";
import type { AppState, Bot, Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { DETAILS_BOX, DetailsLabel } from "./BotDetailsRows";

import { memoryLineText, memoryTargetLine, recentLines } from "@/lib/memory-recent";
import { watchMemoryArrival } from "@/lib/memory-clean-events";
import { MemoryCleanTint, reducedMemoryMotion } from "./MemoryCleanMotion";
import { Fold } from "./Fold";

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
export function MemoryFold({ title, hint, meta, open, onToggle, ref, children }: {
  title: string;
  hint: string;
  meta?: ReactNode;
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
          {meta && <span className="shrink-0 text-[12px] text-ink-secondary">{meta}</span>}
          <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      </div>
      {children}
    </section>
  );
}

export function MemoryFile({ text, loading, open, onToggle, ref, children }: {
  text: string;
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

/** Topic files keep their own list and a file opens under its row, so nothing needs a Back. */
export function TopicFiles({ topics, shown, error, onOpen }: {
  topics: MemoryTopic[];
  shown: { name: string; text: string } | null;
  error?: string | null;
  onOpen: (name: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const picked = useRef<string | null>(null);
  // show the file just opened; closing one above it also moves its row, maybe out of view
  useLayoutEffect(() => {
    if (picked.current === null) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>("[data-topic]") ?? [])].find((each) => each.dataset.topic === picked.current);
    picked.current = null;
    row?.parentElement?.scrollIntoView({ block: "nearest" });
  }, [shown]);
  if (!topics.length) return null;
  return (
    <MemoryFold
      title={t("bot.memoryTopics")}
      hint={t("bot.memoryTopicsHelp")}
      meta={t(topics.length === 1 ? "bot.memoryFileTopicsOne" : "bot.memoryFileTopics", { count: topics.length })}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <Fold open={open}>
        <div ref={list}>
          {topics.map((entry) => {
            const here = shown?.name === entry.name;
            return (
              // the margin keeps a row clear of the sticky header above it
              <div key={entry.name} className="scroll-mt-20 border-t border-hairline/40 first:border-t-0">
                <button
                  type="button"
                  data-topic={entry.name}
                  aria-expanded={here}
                  onClick={() => { picked.current = entry.name; onOpen(entry.name); }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-control/40 motion-reduce:transition-none"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.name}</span>
                  <span className="shrink-0 text-[12px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                </button>
                {here && (
                  <div className="mx-4 mb-3 animate-fade-in whitespace-pre-wrap break-words rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink">
                    {shown.text}
                  </div>
                )}
              </div>
            );
          })}
          {error && <div className="border-t border-hairline/40 px-4 py-2.5 text-[12px] text-danger">{error}</div>}
        </div>
      </Fold>
    </MemoryFold>
  );
}

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
