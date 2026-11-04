// Concept for the usage wait card (today: ChatView ErrorRow with usageWait).
// A chat that was mid-turn when its account ran out keeps waiting (#801), but the card
// says who is out, when it is back, and offers the one move that helps: use another account.
import { cn } from "@/lib/cn";
import { accountById, engineName, label, use, useDesk, useTick } from "./desk-store";
import { engineView, lineOf, Tile } from "./Desk";
import { Spark } from "./Chart";
import { useDeskText } from "./strings";
import "./desk.css";

type Wait = { id: string; weekly: boolean; state: string; resumesAt: number | null; cancelable?: boolean };

/** The prototype knows which account the waiting chat was on; the build reads it from the wait row. */
export function DeskWaitCard({ wait, accountId = "acct_c2", raw }: { wait: Wait; accountId?: string; raw?: string }) {
  const s = useDesk();
  const now = useTick(1000);
  const x = useDeskText();
  const out = accountById(accountId);
  if (!out) return null;
  const line = lineOf(out, now);
  const view = engineView(s, out.engine, now);
  const target = view.inUse.id !== out.id ? view.inUse : view.next;
  const back = wait.resumesAt ?? (line.verdict.kind === "out" ? line.verdict.back : null);
  return (
    <div className="flex justify-start">
      <div title={raw} className="w-full max-w-[min(25rem,100%)] rounded-xl border border-hairline/50 bg-inset px-3.5 py-3">
        <div className="flex items-center gap-2">
          <Tile n={out.n} />
          <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">{x.t("waitTitle", { name: label(out) })}</span>
          {back && <span className="desk-num ml-auto shrink-0 text-[12px] text-ink-secondary">↻ {x.countdown(back - now)}</span>}
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <span className="desk-num text-[12.5px] text-ink-secondary">{back ? x.t("waitBack", { time: x.when(back, now) }) : x.t("noData")}</span>
          <Spark win={line.win} now={now} verdict={line.verdict} width={88} height={22} cols={10} />
        </div>
        <div className="mt-3 flex items-center gap-4">
          {target && (
            <button type="button" onClick={() => use(out.engine, target.id)}
              className={cn("rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink hover:opacity-90", "[@media(pointer:coarse)]:py-2")}>
              {x.t("use", { n: target.nickname ?? `${engineName(target.engine)} ${target.n}` })}
            </button>
          )}
          {wait.cancelable && <button type="button" className="text-[12.5px] text-ink-secondary hover:text-ink [@media(pointer:coarse)]:py-2">{x.t("cancel")}</button>}
        </div>
      </div>
    </div>
  );
}
