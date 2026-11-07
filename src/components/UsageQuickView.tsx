// The compact desk for one chat's engine, grown out of the line that opened it.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { EASE_ENTRANCE, MOTION_FAST_MS } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import type { UsageBoard, UsageBoardAccount, UsageBoardEngine } from "@/lib/usage-board";
import { checkedMain, type UsageBoardState } from "@/lib/usage-board-client";
import { useBackLayer } from "@/lib/use-back-layer";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { useVisibleClock } from "@/lib/use-visible-clock";
import { useStore } from "@/state/store";
import { useAutoRefresh } from "@/lib/usage-auto-refresh";
import { ProviderMark } from "./ProviderIcons";
import { AccountGroup, AccountRow, ENGINE_DRIVER, engineName, Hero, type Clock } from "./UsageDesk";
import { usageAccounts } from "./usage-layout";
import "./UsageDesk.css";

const HOUR = 3_600_000;
const GAP = 6;
const MESSAGE_KEPT = 48;
/** Phone: the All usage row, its rule and the view's border always show, so the view never shrinks to nothing. */
const FOOTER_KEPT = 51;
/** Hidden for the bars-first look: the hero and its chart stay in code, not rendered. */
const SHOW_QUICK_HERO = false;
/** Phone heights under this drop the header and seat Close beside All usage. */
const TIGHT = 320;

type Spot = { left: number; bottom: number; width: number; maxHeight: number; dimBottom: number };

/** Where the view may start: 48 px into the last message showing in the transcript (all of it when shorter). */
function keptTop(floor: number) {
  const transcript = document.querySelector("[data-orbit-transcript]");
  const box = transcript?.getBoundingClientRect();
  const top = Math.max(box?.top ?? floor, floor);
  if (!transcript || !box) return top + MESSAGE_KEPT;
  // Rows are display: contents, so a range measures what they paint.
  const range = document.createRange();
  const rows = transcript.querySelectorAll("[data-mid]");
  for (let i = rows.length - 1; i >= 0; i--) {
    range.selectNodeContents(rows[i]!);
    const rect = range.getBoundingClientRect?.();
    const from = Math.max(rect?.top ?? 0, top);
    const to = Math.min(rect?.bottom ?? 0, box.bottom);
    if (to > from) return from + Math.min(MESSAGE_KEPT, to - from);
    if ((rect?.bottom ?? 0) <= top && (rect?.height ?? 0) > 0) break;
  }
  return top + MESSAGE_KEPT;
}

/** Phone: at most 60% of the visual viewport, chrome included, with the last message still showing above it. */
function place(anchor: HTMLElement, phone: boolean, terminal: boolean): Spot {
  // Terminal skins seat the view flat on the whole status line, not on the ticker inside it.
  const seat = (terminal && anchor.closest<HTMLElement>(".term-status")) || anchor;
  const rect = seat.getBoundingClientRect();
  const gap = terminal ? 0 : GAP;
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const height = viewport?.height ?? window.innerHeight;
  const bottom = window.innerHeight - rect.top + gap;
  if (phone) {
    const cap = height * 0.6;
    const room = rect.top - gap - keptTop(top);
    const maxHeight = Math.max(FOOTER_KEPT, Math.floor(Math.min(cap, room)));
    const edge = terminal ? 0 : 16;
    return { left: edge, bottom, width: window.innerWidth - 2 * edge, maxHeight, dimBottom: window.innerHeight - rect.top };
  }
  const width = Math.min(380, window.innerWidth - 24);
  const left = Math.max(12, Math.min(anchor.getBoundingClientRect().left - 4, window.innerWidth - width - 12));
  return { left, bottom, width, maxHeight: Math.max(0, Math.floor(rect.top - gap - top - 12)), dimBottom: 0 };
}

export function UsageQuickView({ engine, account, board, state, anchor, onClose }: {
  engine: UsageBoardEngine; account: UsageBoardAccount; board: UsageBoard; state: UsageBoardState;
  anchor: RefObject<HTMLElement | null>; onClose: () => void;
}) {
  const { t, locale } = useI18n();
  useAutoRefresh(board);
  const { state: store, dispatch, refreshInstances } = useStore();
  const phone = useIsPhone();
  const terminal = isTerminalSkin(useSkin());
  const box = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [viewedId, setViewedId] = useState(account.id);
  const viewed = engine.accounts.find((each) => each.id === viewedId) ?? account;
  const minute = useVisibleClock();
  const soon = viewed.windows.some((each) => each.resetsAt !== null && each.resetsAt > minute && each.resetsAt - minute < HOUR);
  const clock: Clock = { t, locale: localeTag(locale), now: useVisibleClock(soon) };
  const checked = checkedMain(state, engine.base);

  const close = (focus = true) => {
    onClose();
    if (focus) anchor.current?.focus();
  };
  const closeRef = useRef(close);
  useLayoutEffect(() => { closeRef.current = close; });
  useBackLayer(true, close);

  useLayoutEffect(() => {
    const update = () => {
      if (!anchor.current) return;
      const next = place(anchor.current, phone, terminal);
      setSpot((spot) => spot && (Object.keys(next) as (keyof Spot)[]).every((key) => spot[key] === next[key]) ? spot : next);
    };
    // The transcript may still be settling when the keyboard opens (it keeps to the bottom): measure again when it scrolls.
    const scrolled = (event: Event) => { if (!box.current?.contains(event.target as Node)) update(); };
    update();
    const viewport = window.visualViewport;
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      document.removeEventListener("scroll", scrolled, { capture: true });
    };
  }, [anchor, phone, terminal]);

  useLayoutEffect(() => {
    if (!spot || reducedMotion()) return;
    box.current?.animate?.([{ opacity: 0, transform: "translateY(6px) scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: MOTION_FAST_MS, easing: EASE_ENTRANCE });
  }, [Boolean(spot)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || anchor.current?.contains(target)) return;
      // An open account menu inside the view is the top layer; its own listener closes it.
      if (box.current?.querySelector('[role="menu"]')) return;
      closeRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [anchor]);

  const settings = (section: "usage" | "connections") => {
    close(false);
    dispatch({ type: "toggleAppSettings", open: true, section });
  };

  if (!spot) return null;
  const tight = phone && spot.maxHeight < TIGHT;
  // No room for one line (the scroll area's own padding is 24 px): only All usage and Close show.
  const bare = tight && spot.maxHeight < FOOTER_KEPT + 24;
  const closeButton = (
    <button type="button" data-quick-close="" aria-label={t("usage.chat.close")} onClick={() => close()}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-[3px] [corner-shape:bevel] text-ink-secondary hover:bg-raised-hover [@media(pointer:coarse)]:size-11">
      <X size={15} aria-hidden="true" />
    </button>
  );
  return createPortal(
    <>
      {phone && <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 bg-black/45" style={{ bottom: spot.dimBottom }} />}
      <div ref={box} role="dialog" aria-label={t("usage.chat.quickTitle")} data-usage-quick="" data-usage-desk=""
        className={cn("fixed z-50 flex flex-col overflow-hidden border border-hairline/60 bg-panel shadow-2xl",
          terminal ? "rounded-none" : "rounded-[6px] [corner-shape:bevel]")}
        style={{ left: spot.left, bottom: spot.bottom, width: spot.width, maxHeight: spot.maxHeight }}>
        {!tight && <div className="flex shrink-0 items-center gap-2 py-1 pl-4 pr-1.5">
          <span data-engine-mark="" className={cn("flex shrink-0", terminal && "usage-glyphs w-[3ch] text-[12px]")}><ProviderMark driverKind={ENGINE_DRIVER[engine.engine] ?? engine.engine} size={16} /></span>
          <span data-engine-name="" className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{engineName(engine.engine)}</span>
          {closeButton}
        </div>}
        <div data-quick-scroll="" className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-3", tight && "pt-3", bare && "hidden")}>
          {SHOW_QUICK_HERO && <Hero key={engine.base} engine={engine} account={viewed} accounts={engine.accounts} select={setViewedId} foldChart
            terminal={terminal} phone={phone} clock={clock} instances={store.instances} />}
          <AccountGroup label={engineName(engine.engine)} terminal={terminal}>
            {usageAccounts(engine).map((each) => <AccountRow key={each.id} engine={engine} account={each} board={board} state={state} checked={each.id === checked}
              terminal={terminal} clock={clock} reloadInstances={() => refreshInstances()} signIn={() => settings("connections")} />)}
          </AccountGroup>
          {state.failed.has(engine.base) && <div role="alert" className="text-[12px] text-danger">{t("usage.desk.mainFailed")}</div>}
        </div>
        <div className="flex shrink-0 items-center border-t border-hairline/50">
          <button type="button" data-all-usage="" onClick={() => settings("usage")}
            className="flex min-w-0 flex-1 items-center justify-between gap-3 self-stretch px-4 text-left text-[13px] text-ink transition-colors duration-100 hover:bg-raised-hover motion-reduce:transition-none"
            style={{ minHeight: phone ? 48 : 40 }}>
            <span>{t("usage.chat.allUsage")}</span>
            {phone ? <ChevronRight size={16} aria-hidden="true" className="-mr-1 text-ink-secondary" />
              : <kbd className="usage-num rounded-[3px] border border-hairline px-1.5 py-0.5 font-sans text-[10.5px] leading-none text-ink-secondary">Alt U</kbd>}
          </button>
          {tight && <span className="flex shrink-0 border-l border-hairline/50 px-0.5">{closeButton}</span>}
        </div>
      </div>
    </>,
    document.body,
  );
}
