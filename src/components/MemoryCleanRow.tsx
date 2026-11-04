import { useRef } from "react";
import { localeTag, useI18n } from "@/lib/i18n";
import type { MemoryCleanRun } from "@/lib/memory-clean";
import { MemoryCleanTint } from "./MemoryCleanMotion";

export function MemoryCleanUndo({ onUndo }: { onUndo: () => void }) {
  const { t } = useI18n();
  return <span className="whitespace-nowrap"><span aria-hidden="true">·</span> <button type="button" className="font-medium text-accent-text" onClick={onUndo}>{t("chat.memoryTidyUndo")}</button></span>;
}

export function MemoryCleanRow({ run, onUndo, nonce }: { run: MemoryCleanRun; onUndo: () => void; nonce?: number }) {
  const { t, locale } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  const same = Math.round(run.beforeBytes / 1024) === Math.round(run.afterBytes / 1024);
  const kb = (bytes: number) => same ? (bytes / 1024).toFixed(1) : Math.round(bytes / 1024);
  const date = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" }).format(run.at);
  const parts = [run.merged ? t("bot.memoryTidyMerged", { count: run.merged }) : "", run.replaced ? t("bot.memoryTidyReplaced", { count: run.replaced }) : "", run.moved ? t("bot.memoryTidyMoved", { count: run.moved }) : ""].filter(Boolean).join(", ").split("memory-history.md");
  return (
    <div ref={row} className="mx-4 mb-4 border-t border-hairline/40 pt-3">
      <div className="mc-target break-keep text-[12px] leading-relaxed text-ink-secondary">
        {nonce !== undefined && <MemoryCleanTint key={nonce} nonce={nonce} row={row} />}
        <span>{run.undoneAt !== null ? t("chat.memoryTidyUndone") : t("bot.memoryTidied", { date, before: kb(run.beforeBytes), after: kb(run.afterBytes) })}</span>{run.undoneAt === null && run.undoable && <> <MemoryCleanUndo onUndo={onUndo} /></>}
      </div>
      {run.undoneAt === null && <div className="break-keep text-[12px] leading-relaxed text-ink-secondary">{parts.map((part, i) => <span key={i}>{i > 0 && <span className="whitespace-nowrap">memory-history.md</span>}{part}</span>)}</div>}
    </div>
  );
}
