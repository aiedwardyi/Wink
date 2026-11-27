import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import type { DreamFix, DreamPr, DreamRun, MemoryCleanRun } from "@/lib/memory-clean";
import { MemoryCleanTint } from "./MemoryCleanMotion";

const DREAMED_FILE = "memory/dreamed.md";

export function MemoryCleanUndo({ onUndo }: { onUndo: () => void }) {
  const { t } = useI18n();
  return <span className="whitespace-nowrap"><span aria-hidden="true">·</span> <button type="button" className="font-medium text-accent-text" onClick={onUndo}>{t("chat.memoryTidyUndo")}</button></span>;
}

type OnFix = (target: string, undo: boolean) => void;

function FixLine({ item, quote, day, onFix }: { item: DreamFix; quote: (text: string | null) => string; day: (at: number) => string; onFix?: OnFix }) {
  const { t } = useI18n();
  const said = t("bot.dreamFix", { text: quote(item.text), date: day(item.evidence.at), quote: `"${item.evidence.quote}"`, by: quote(item.by) });
  if (item.done && item.done.undoneAt === undefined) return <>{said} {t("bot.dreamFixed", { file: DREAMED_FILE })}{onFix && <> <MemoryCleanUndo onUndo={() => onFix(item.target, true)} /></>}</>;
  if (item.done) return <>{said} {t("bot.dreamFixUndone")}</>;
  if (item.outdated !== undefined) return <>{said} {t("bot.dreamFixOutdated")}</>;
  if (item.listOnly) return <>{said} {t("bot.dreamFixByHand")}</>;
  return <>{said}{onFix && <> <span className="whitespace-nowrap"><span aria-hidden="true">·</span> <button type="button" className="font-medium text-accent-text" onClick={() => onFix(item.target, false)}>{t("bot.dreamFixOk")}</button></span></>}</>;
}

function DreamList({ dream, onFix }: { dream: DreamRun; onFix?: OnFix }) {
  const { t, locale } = useI18n();
  const day = (at: number) => new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" }).format(at);
  const quote = (text: string | null) => text === null ? t("bot.dreamHidden") : `"${text.replace(/^\s*[-*+]\s+/, "")}"`;
  const prs = (list: readonly DreamPr[]) => list.map((pr) => pr.repo ? `${pr.repo}#${pr.number}` : `PR ${pr.number}`).join(", ");
  const merged = (list: readonly DreamPr[]) => day(Math.max(...list.map((pr) => pr.mergedAt)));
  const lands = { stays: () => t("bot.dreamStays"), "leaves-now": () => t("bot.dreamLeavesNow", { date: day(dream.dropUntil) }), "leaves-next": () => t("bot.dreamLeavesNext", { date: day(dream.dropUntil) }) };
  const lines: ReactNode[] = [
    ...(dream.fixes?.items ?? []).map((item) => <FixLine item={item} quote={quote} day={day} onFix={onFix} />),
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

function DreamRow({ run, onFix, className }: { run: MemoryCleanRun & { dream: DreamRun }; onFix?: OnFix; className?: string }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const { dream } = run;
  const time = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(run.at);
  const moves = dream.notes.items.length;
  // a fix the user OK'd changed MEMORY.md, so the row says so the way an applied cleanup does
  const applied = dream.fixes?.items.flatMap((item) => (item.done && item.done.undoneAt === undefined ? [item.done.at] : [])) ?? [];
  const fixes = dream.fixes?.items.filter((item) => !item.done && item.outdated === undefined).length ?? 0;
  const closes = dream.asks.items.filter((item) => item.op === "close").length;
  const count = (n: number, one: "bot.dreamNote" | "bot.dreamTodo", many: "bot.dreamNotes" | "bot.dreamTodos") => t(n === 1 ? one : many, { count: n });
  const notes = dream.notes.state === "off-here" ? t("bot.dreamNotesOffHere") : ["checked", "unchanged"].includes(dream.notes.state) ? "" : t("bot.dreamNotesNotChecked");
  const listed = moves + (dream.fixes?.items.length ?? 0) + dream.asks.items.length + dream.asks.skipped + dream.asks.unchecked > 0;
  const would = { notes: count(moves, "bot.dreamNote", "bot.dreamNotes"), fixes: count(fixes, "bot.dreamNote", "bot.dreamNotes"), asks: count(closes, "bot.dreamTodo", "bot.dreamTodos") };
  return (
    <div className={cn("mx-4 mb-4 border-t border-hairline/40 pt-3", className)}>
      <div className="break-keep text-[12px] leading-relaxed text-ink-secondary">
        <span>{applied.length ? t("bot.memoryTidied", { date: new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" }).format(Math.max(...applied)) }) : t("bot.dreamDry", { time })} {listed ? t(fixes ? "bot.dreamWouldFix" : "bot.dreamWould", would) : t("bot.dreamNothing")}</span>
        {listed && <> <span aria-hidden="true">·</span> <button type="button" className="font-medium text-accent-text" aria-expanded={open} onClick={() => setOpen(!open)}>{t(open ? "bot.dreamHide" : "bot.dreamShow")}</button></>}
      </div>
      <div className="break-keep text-[12px] leading-relaxed text-ink-secondary">{[t("bot.dreamPaused"), notes].filter(Boolean).join(" ")}</div>
      {open && <div className="break-keep text-[12px] leading-relaxed text-ink-secondary"><DreamList dream={dream} onFix={onFix} /></div>}
    </div>
  );
}

export function MemoryCleanRow({ run, onUndo, onFix, nonce, className }: { run: MemoryCleanRun; onUndo: () => void; onFix?: OnFix; nonce?: number; className?: string }) {
  const { t, locale } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  if (run.dream) return <DreamRow run={{ ...run, dream: run.dream }} onFix={onFix} className={className} />;
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
