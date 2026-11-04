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
import { AccountRow, engineName, Hero, type Clock } from "./UsageDesk";
import "./UsageDesk.css";

const HOUR = 3_600_000;
const GAP = 6;
const TRANSCRIPT_KEPT = 48;

type Spot = { left: number; bottom: number; width: number; maxHeight: number; dimBottom: number };

/** Phone: at most 60% of the visual viewport, chrome included, and 48 px of the transcript still showing above it. */
function place(anchor: HTMLElement, phone: boolean, terminal: boolean): Spot {
  const rect = anchor.getBoundingClientRect();
  const gap = terminal ? 0 : GAP;
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const height = viewport?.height ?? window.innerHeight;
  const bottom = window.innerHeight - rect.top + gap;
  if (phone) {
    const transcript = document.querySelector("[data-orbit-transcript]")?.getBoundingClientRect().top ?? top;
    const room = rect.top - gap - Math.max(transcript, top) - TRANSCRIPT_KEPT;
    const width = window.innerWidth - 32;
    return { left: 16, bottom, width, maxHeight: Math.max(0, Math.floor(Math.min(height * 0.6, room))), dimBottom: window.innerHeight - rect.top };
  }
  const width = Math.min(380, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left - 4, window.innerWidth - width - 12));
  return { left, bottom, width, maxHeight: Math.max(0, Math.floor(rect.top - gap - top - 12)), dimBottom: 0 };
}

export function UsageQuickView({ engine, account, board, state, anchor, onClose }: {
  engine: UsageBoardEngine; account: UsageBoardAccount; board: UsageBoard; state: UsageBoardState;
  anchor: RefObject<HTMLElement | null>; onClose: () => void;
}) {
  const { t, locale } = useI18n();
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
  const checked = checkedMain(state, engine.engine);

  const close = (focus = true) => {
    onClose();
    if (focus) anchor.current?.focus();
  };
  useBackLayer(true, close);

  useLayoutEffect(() => {
    const update = () => { if (anchor.current) setSpot(place(anchor.current, phone, terminal)); };
    update();
    const viewport = window.visualViewport;
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
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
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  });

  const allUsage = () => {
    close(false);
    dispatch({ type: "toggleAppSettings", open: true, section: "usage" });
  };

  if (!spot) return null;
  return createPortal(
    <>
      {phone && <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 bg-black/45" style={{ bottom: spot.dimBottom }} />}
      <div ref={box} role="dialog" aria-label={t("usage.chat.quickTitle")} data-usage-quick="" data-usage-desk=""
        className={cn("fixed z-50 flex flex-col overflow-hidden border border-hairline/60 bg-panel shadow-2xl",
          terminal ? "rounded-none" : "rounded-[6px] [corner-shape:bevel]")}
        style={{ left: spot.left, bottom: spot.bottom, width: spot.width, maxHeight: spot.maxHeight }}>
        <div className="flex shrink-0 items-center justify-between gap-2 py-1.5 pl-4 pr-1.5">
          <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">{engineName(engine.engine)}</span>
          <button type="button" data-quick-close="" aria-label={t("usage.chat.close")} onClick={() => close()}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[3px] [corner-shape:bevel] text-ink-secondary hover:bg-raised-hover [@media(pointer:coarse)]:size-11">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div data-quick-scroll="" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-3">
          <Hero key={engine.engine} engine={engine} account={viewed} accounts={engine.accounts} select={setViewedId} foldChart
            terminal={terminal} phone={phone} clock={clock} instances={store.instances} />
          {state.failed.has(engine.engine) && <div role="alert" className="text-[12px] text-danger">{t("usage.desk.mainFailed")}</div>}
          {engine.accounts.length > 1 && <div role="group" aria-label={engineName(engine.engine)} className="-mx-1 flex min-w-0 flex-col divide-y divide-hairline/40 rounded-[3px] [corner-shape:bevel] bg-inset">
            {engine.accounts.map((each) => <AccountRow key={each.id} engine={engine} account={each} board={board} state={state} checked={each.id === checked}
              phone={phone} terminal={terminal} clock={clock} reloadInstances={() => refreshInstances()} />)}
          </div>}
        </div>
        <button type="button" data-all-usage="" onClick={allUsage}
          className="flex shrink-0 items-center justify-between gap-3 border-t border-hairline/50 px-4 text-left text-[13px] text-ink transition-colors duration-100 hover:bg-raised-hover motion-reduce:transition-none"
          style={{ minHeight: phone ? 48 : 40 }}>
          <span>{t("usage.chat.allUsage")}</span>
          {phone ? <ChevronRight size={16} aria-hidden="true" className="-mr-1 text-ink-secondary" />
            : <kbd className="usage-num rounded-[3px] border border-hairline px-1.5 py-0.5 font-sans text-[10.5px] leading-none text-ink-secondary">Alt U</kbd>}
        </button>
      </div>
    </>,
    document.body,
  );
}
