import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import type { DreamPr, DreamRun, MemoryCleanRun } from "@/lib/memory-clean";
import { MemoryCleanTint } from "./MemoryCleanMotion";

const DREAMED_FILE = "memory/dreamed.md";

export function MemoryCleanUndo({ onUndo }: { onUndo: () => void }) {
  const { t } = useI18n();
  return <span className="whitespace-nowrap"><span aria-hidden="true">·</span> <button type="button" className="font-medium text-accent-text" onClick={onUndo}>{t("chat.memoryTidyUndo")}</button></span>;
}

function DreamList({ dream }: { dream: DreamRun }) {
  const { t, locale } = useI18n();
  const day = (at: number) => new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" }).format(at);
  const quote = (text: string | null) => text === null ? t("bot.dreamHidden") : `"${text.replace(/^\s*[-*+]\s+/, "")}"`;
  const prs = (list: readonly DreamPr[]) => list.map((pr) => pr.repo ? `${pr.repo}#${pr.number}` : `PR ${pr.number}`).join(", ");
  const merged = (list: readonly DreamPr[]) => day(Math.max(...list.map((pr) => pr.mergedAt)));
  const lands = { stays: () => t("bot.dreamStays"), "leaves-now": () => t("bot.dreamLeavesNow", { date: day(dream.dropUntil) }), "leaves-next": () => t("bot.dreamLeavesNext", { date: day(dream.dropUntil) }) };
  const lines = [
    ...dream.notes.items.map((item) => t(item.why === "duplicate" ? "bot.dreamMoveDuplicate" : item.why === "replaced" ? "bot.dreamMoveReplaced" : "bot.dreamMoveExpired", { text: quote(item.text), by: quote(item.by), file: item.history })),
    ...dream.asks.items.map((item) => item.op === "close"
      ? `${t("bot.dreamClose", { ask: quote(item.ask), prs: prs(item.prs), date: merged(item.prs) })} ${lands[item.lands ?? "stays"]()}`
      : item.op === "ask"
        ? t("bot.dreamAsk", { ask: quote(item.ask), prs: prs(item.prs) })
        : t("bot.dreamFallOut", { ask: quote(item.ask), date: day(item.closedAt ?? 0), until: day(dream.dropUntil) })),
    dream.asks.skipped ? t("bot.dreamSkipped", { count: dream.asks.skipped }) : "",
    dream.asks.unchecked ? t("bot.dreamUnchecked", { count: dream.asks.unchecked }) : "",
    t("bot.dreamKept", { date: day(dream.runUntil) }),
  ].filter(Boolean);
  return <ul className="mt-1 list-disc space-y-1 pl-4">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul>;
}

function DreamRow({ run, className }: { run: MemoryCleanRun & { dream: DreamRun }; className?: string }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const { dream } = run;
  const time = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(run.at);
  const moves = dream.notes.items.length;
  const closes = dream.asks.items.filter((item) => item.op === "close").length;
  const count = (n: number, one: "bot.dreamNote" | "bot.dreamTodo", many: "bot.dreamNotes" | "bot.dreamTodos") => t(n === 1 ? one : many, { count: n });
  const notes = dream.notes.state === "off-here" ? t("bot.dreamNotesOffHere") : ["checked", "unchanged"].includes(dream.notes.state) ? "" : t("bot.dreamNotesNotChecked");
  const listed = moves + dream.asks.items.length + dream.asks.skipped + dream.asks.unchecked > 0;
  return (
    <div className={cn("mx-4 mb-4 border-t border-hairline/40 pt-3", className)}>
      <div className="break-keep text-[12px] leading-relaxed text-ink-secondary">
        <span>{t("bot.dreamDry", { time })} {listed ? t("bot.dreamWould", { notes: count(moves, "bot.dreamNote", "bot.dreamNotes"), asks: count(closes, "bot.dreamTodo", "bot.dreamTodos") }) : t("bot.dreamNothing")}</span>
        {listed && <> <span aria-hidden="true">·</span> <button type="button" className="font-medium text-accent-text" aria-expanded={open} onClick={() => setOpen(!open)}>{t(open ? "bot.dreamHide" : "bot.dreamShow")}</button></>}
      </div>
      <div className="break-keep text-[12px] leading-relaxed text-ink-secondary">{[t("bot.dreamPaused"), notes].filter(Boolean).join(" ")}</div>
      {open && <div className="break-keep text-[12px] leading-relaxed text-ink-secondary"><DreamList dream={dream} /></div>}
    </div>
  );
}

export function MemoryCleanRow({ run, onUndo, nonce, className }: { run: MemoryCleanRun; onUndo: () => void; nonce?: number; className?: string }) {
  const { t, locale } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  if (run.dream) return <DreamRow run={{ ...run, dream: run.dream }} className={className} />;
  const date = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" }).format(run.at);
  const parts = [run.merged ? t("bot.memoryTidyMerged", { count: run.merged }) : "", run.replaced ? t("bot.memoryTidyReplaced", { count: run.replaced }) : "", run.moved ? t("bot.memoryTidyMoved", { count: run.moved }) : ""].filter(Boolean).join(", ").split(DREAMED_FILE);
  return (
    <div ref={row} className={cn("mx-4 mb-4 border-t border-hairline/40 pt-3", className)}>
      <div className="mc-target break-keep text-[12px] leading-relaxed text-ink-secondary">
        {nonce !== undefined && <MemoryCleanTint key={nonce} nonce={nonce} row={row} />}
        <span>{run.undoneAt !== null ? t("chat.memoryTidyUndone") : t("bot.memoryTidied", { date })}</span>{run.undoneAt === null && run.undoable && <> <MemoryCleanUndo onUndo={onUndo} /></>}
      </div>
      {run.undoneAt === null && <div className="break-keep text-[12px] leading-relaxed text-ink-secondary">{parts.map((part, i) => <span key={i}>{i > 0 && <span className="whitespace-nowrap">{DREAMED_FILE}</span>}{part}</span>)}</div>}
    </div>
  );
}
