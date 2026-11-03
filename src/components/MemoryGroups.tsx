import type { ReactNode, Ref } from "react";
import { Brain, ChevronDown } from "lucide-react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";

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

export function MemoryGroup({ title, help, children }: { title?: string; help?: string; children?: ReactNode }) {
  return (
    <section className="border-t border-hairline/40 p-4 first:border-t-0">
      {title && <div className="text-[14px] font-medium text-ink">{title}</div>}
      {help && <div className="mt-0.5 break-keep text-[12px] leading-relaxed text-ink-secondary">{help}</div>}
      {children}
    </section>
  );
}

export function MemoryFile({ text, topics, loading, open, onToggle, ref, children }: {
  text: string;
  topics: number;
  loading: boolean;
  open: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const lines = text.split("\n").filter((line) => line.trim()).length;
  return (
    <section className="border-t border-hairline/40 first:border-t-0">
      <button ref={ref} type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3 p-4 text-left hover:bg-control/40">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{t("bot.memoryFile")}</div>
          {!loading && (lines > 0 || topics > 0) && (
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-ink-secondary">
              <span>{t(lines === 1 ? "bot.memoryFileLinesOne" : "bot.memoryFileLines", { count: lines })}</span>
              {topics > 0 && <span>{t(topics === 1 ? "bot.memoryFileTopicsOne" : "bot.memoryFileTopics", { count: topics })}</span>}
            </div>
          )}
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>
      {children}
    </section>
  );
}

export function NotedLines({ text }: { text: string }) {
  const { t, locale } = useI18n();
  const lines = notedLines(text);
  if (!lines.length) return null;
  const day = new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" });
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {lines.slice(0, SHOWN).map((line, index) => (
        <li key={index} className="flex items-baseline justify-between gap-3 text-[13px] text-ink">
          <span className="min-w-0 break-words">{line.fact}</span>
          <span className="shrink-0 text-[11.5px] text-ink-secondary">{day.format(line.at)}</span>
        </li>
      ))}
      {lines.length > SHOWN && (
        <li className="text-[12px] text-ink-secondary">{t("bot.memoryMore", { count: lines.length - SHOWN })}</li>
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

export function MemoryTask({ bot }: { bot: Bot }) {
  const { t } = useI18n();
  const packet = currentTask(bot);
  if (!packet) return null;
  const done = packet.plan.filter((step) => step.status === "done").length;
  return (
    <MemoryGroup title={t("bot.memoryTask")}>
      <div className="mt-1.5 break-words text-[13px] text-ink">{packet.goal}</div>
      {packet.plan.length > 0 && (
        <div className="mt-1 text-[12px] text-ink-secondary">{t("bot.memoryTaskSteps", { done, total: packet.plan.length })}</div>
      )}
      {packet.nextAction.trim() && (
        <div className="mt-0.5 break-words text-[12px] text-ink-secondary">{t("bot.memoryTaskNext", { action: packet.nextAction })}</div>
      )}
    </MemoryGroup>
  );
}
