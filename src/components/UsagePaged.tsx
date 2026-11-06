import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Translate } from "@/lib/i18n";
import { EASE_ENTRANCE } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import type { UsageBoardAccount, UsageBoardEngine } from "@/lib/usage-board";
import { AccountPicker } from "./UsageAccounts";

const ARROW = "relative flex size-7 items-center justify-center rounded-[3px] [corner-shape:bevel] text-ink transition-[background-color,transform] duration-100 enabled:hover:bg-raised-hover enabled:active:scale-90 enabled:active:bg-raised-hover disabled:opacity-25 motion-reduce:transition-none [@media(pointer:coarse)]:size-11";
export type RowSlots = { name?: ReactNode };

/** Today's layout: Main on the left and one other account on the right, picked with the dropdown or the arrows (phones page through every account, Main first). Picking only views an account; Main changes only with Use. The arrows sit on the engine row, so a phone row keeps room for the name. */
export function PagedAccounts({ engine, checked, stacked, t, head, row, group }: {
  engine: UsageBoardEngine; checked: string | null; stacked: boolean; t: Translate;
  head: (arrows?: ReactNode) => ReactNode; row: (account: UsageBoardAccount, slots?: RowSlots) => ReactElement; group: (content: ReactNode) => ReactNode;
}) {
  const main = engine.accounts.find((each) => each.id === checked) ?? engine.accounts[0]!;
  const others = engine.accounts.filter((each) => each !== main);
  const pages = stacked ? [main, ...others] : others;
  const [selected, setSelected] = useState<string | null>(null);
  const [shownMain, setShownMain] = useState(main.id);
  if (shownMain !== main.id) {
    // Like today: after Use, the old Main stays in view on the right.
    setShownMain(main.id);
    if (!stacked) setSelected(shownMain);
  }
  const index = Math.max(0, pages.findIndex((each) => each.id === selected));
  const current = pages[index];
  const live = useRef<HTMLDivElement>(null);
  const turn = useRef(0);
  useLayoutEffect(() => {
    const dir = turn.current;
    turn.current = 0;
    if (!dir || reducedMotion()) return;
    // Only what sits under the head moves, so the arrows stay under the finger.
    for (const part of live.current?.firstElementChild?.children ?? []) {
      if (!part.hasAttribute("data-account-head")) part.animate([{ opacity: 0, transform: `translateX(${dir * 12}px)` }, {}], { duration: 160, easing: EASE_ENTRANCE });
    }
  }, [current?.id]);
  if (!current) return <>{head()}{group(row(main))}</>;
  const go = (id: string) => {
    turn.current = Math.sign(pages.findIndex((each) => each.id === id) - index);
    setSelected(id);
  };
  const arrows = pages.length > 1 && <span className="flex shrink-0 items-center">
    <button type="button" aria-label={t("accounts.previous")} disabled={index === 0} onClick={() => go(pages[index - 1]!.id)} className={ARROW}>
      <ChevronLeft size={16} aria-hidden="true" />
    </button>
    <button type="button" aria-label={t("accounts.next")} disabled={index === pages.length - 1} onClick={() => go(pages[index + 1]!.id)} className={ARROW}>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  </span>;
  const picker = (account: UsageBoardAccount) => pages.length > 1 ? <AccountPicker viewedId={account.id} select={go}
    accounts={pages.map((each) => ({ id: each.id, name: each.name, number: each.number, main: each.id === main.id }))} /> : undefined;
  return (<>
    {head(arrows)}
    {group(<div className={cn("grid min-w-0", !stacked && "grid-cols-2")}>
      {!stacked && <div data-account-column="main" className="min-w-0">{row(main)}</div>}
      <div data-account-column={stacked ? "pages" : "other"} className={cn("grid min-w-0", !stacked && "border-l border-hairline/70")}>
        {pages.map((each) => each !== current && <div key={each.id} className="invisible col-start-1 row-start-1 min-w-0" inert aria-hidden="true">
          {row(each, { name: picker(each) })}
        </div>)}
        {/* One live row for every page: a pick swaps its account but keeps the picker mounted, so focus stays on it. */}
        <div key="live" ref={live} className="col-start-1 row-start-1 min-w-0">{cloneElement(row(current, { name: picker(current) }), { key: "live" })}</div>
      </div>
    </div>)}
  </>);
}
