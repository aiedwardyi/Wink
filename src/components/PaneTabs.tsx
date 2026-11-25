import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bot, FileText, Folder, Globe, History, Image as ImageIcon, Images, Map as MapIcon, MonitorCheck, Plus, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { MENU_ITEM_HOVER } from "@/lib/menu-style";
import { EASE_STANDARD, MOTION_MODERATE_MS } from "@/lib/motion";
import { reducedMotion, SWIPE_MOTION_MS, SWIPE_SPRING } from "@/lib/phone-swipe";
import { moveTab, PANE_KEY, type PaneEntry, type PaneTool } from "@/lib/show-pane";
import { LIFT_SCALE, soften } from "@/lib/use-touch-drag";
import { MENU_CLASS, menuKeyDown } from "./MessageMenu";

export const FILE_ICON = { image: ImageIcon, pdf: FileText, page: Globe, text: FileText, folder: Folder };
export const TOOL_ICON: Record<PaneTool, LucideIcon> = { workers: Bot, media: Images, check: MonitorCheck, map: MapIcon, timeline: History };
export const TOOL_LABEL = { workers: "show.workers", media: "show.media", check: "show.check", map: "show.map", timeline: "show.timeline" } as const;
const ROW = "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink";
const LIFT_SHADOW = "0 8px 24px rgb(0 0 0 / .35)";
export const PANE_WIDTH_KEY = "omb-pane-width";
const PANE_MIN = 380;
// The dock's clamp in VerifyWatch.css leaves the chat this much.
const CHAT_MIN = 560;
const STEP = 24;

export interface ToolRow { tool: PaneTool; off?: string }
export interface TabView { key: string; entry: PaneEntry; name: string; icon: LucideIcon }

function ToolRows({ rows, onPick }: { rows: readonly ToolRow[]; onPick: (tool: PaneTool) => void }) {
  const { t } = useI18n();
  return (
    <>
      {rows.map(({ tool, off }) => {
        const Icon = TOOL_ICON[tool];
        return (
          <button key={tool} type="button" role="menuitem" data-pane-tool={tool} aria-disabled={off ? true : undefined} title={off} onClick={() => { if (!off) onPick(tool); }} className={cn(ROW, off ? "cursor-default opacity-45" : MENU_ITEM_HOVER)}>
            <Icon size={16} aria-hidden className="shrink-0 text-ink-secondary" />
            <span className="flex-1">{t(TOOL_LABEL[tool])}</span>
            <kbd className="pl-6 font-sans text-[12px] text-ink-secondary">{`Alt+${PANE_KEY[tool]}`}</kbd>
          </button>
        );
      })}
    </>
  );
}

/** The "+" after the tabs: the tool list as a menu. */
export function PaneToolMenu({ rows, onPick }: { rows: readonly ToolRow[]; onPick: (tool: PaneTool) => void }) {
  const { t } = useI18n();
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = menu.current;
    if (!at || !box) return;
    const over = box.getBoundingClientRect().right - (window.innerWidth - 8);
    if (over > 0) box.style.left = `${at.left - over}px`;
    box.querySelector<HTMLElement>("button:not([aria-disabled])")?.focus();
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const away = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !opener.current?.contains(target)) setAt(null);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setAt(null);
      opener.current?.focus();
    };
    const shut = () => setAt(null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", shut);
    window.addEventListener("blur", shut);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", shut);
      window.removeEventListener("blur", shut);
    };
  }, [at]);
  return (
    <>
      <button ref={opener} type="button" className="verify-watch-icon" data-pane-add aria-haspopup="menu" aria-expanded={at ? true : undefined} aria-label={t("show.addTool")} title={t("show.addTool")} onClick={() => {
        const box = opener.current?.getBoundingClientRect();
        setAt(at || !box ? null : { left: box.left, top: box.bottom + 6 });
      }}>
        <Plus size={18} />
      </button>
      {at && createPortal(
        <div ref={menu} role="menu" data-pane-tools-menu className={cn(MENU_CLASS, "z-[60] w-56")} style={{ left: at.left, top: at.top }} onKeyDown={(event) => menuKeyDown(menu, event)}>
          <ToolRows rows={rows} onPick={(tool) => { setAt(null); onPick(tool); }} />
        </div>,
        document.body,
      )}
    </>
  );
}

/** A pane with no tab open: the same list, in the pane. */
export function PaneToolList({ rows, onPick }: { rows: readonly ToolRow[]; onPick: (tool: PaneTool) => void }) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  return (
    <div className="show-pane-tools" data-pane-tools>
      <p>{t("show.addTool")}</p>
      <div ref={list} role="menu" aria-label={t("show.addTool")} className={cn(MENU_CLASS, "static z-auto w-56 animate-none shadow-none")} onKeyDown={(event) => menuKeyDown(list, event)}>
        <ToolRows rows={rows} onPick={onPick} />
      </div>
    </div>
  );
}

interface Drag { key: string; id: number; x0: number; x: number; from: number; to: number; els: HTMLElement[]; lefts: number[]; widths: number[]; view: [number, number]; left: number; ghost?: HTMLElement }
interface Landing { key: string; at: Map<string, number>; look: { scale: string; boxShadow: string; backgroundColor: string; color: string } }

/** The open tabs. A pressed tab follows the pointer from the first pixel; past 4 px it lifts (a copy, so the row's scroll clip never cuts its shadow) and its neighbors slide aside to open its spot. */
export function PaneTabs({ row, threadId, tabs, active, onOpen, onClose, onSay }: { row: RefObject<HTMLDivElement | null>; threadId: string; tabs: readonly TabView[]; active: string | null; onOpen: (entry: PaneEntry) => void; onClose: (tab: TabView, index: number) => void; onSay: (said: string) => void }) {
  const { t } = useI18n();
  const drag = useRef<Drag | null>(null);
  const settle = useRef<Landing | null>(null);
  const escape = useRef<(event: globalThis.KeyboardEvent) => void>(undefined);
  const order = tabs.map((tab) => tab.key).join("\n");
  const spring = () => ({ duration: reducedMotion() ? 0 : SWIPE_MOTION_MS, easing: SWIPE_SPRING });

  // Every tab glides from where it was drawn to its place, and the dropped one comes down from its lift.
  const land = ({ key, at, look }: Landing) => {
    for (const el of row.current?.querySelectorAll<HTMLElement>("[data-pane-tab]") ?? []) {
      const left = el.getBoundingClientRect().left;
      const dx = (at.get(el.dataset.paneTab!) ?? left) - left;
      const translate = [`${dx}px 0`, "0 0"];
      if (el.dataset.paneTab !== key) {
        if (dx) el.animate({ translate }, spring());
        continue;
      }
      const rest = getComputedStyle(el);
      el.animate({ translate, scale: [look.scale, "1"], boxShadow: [look.boxShadow, rest.boxShadow], backgroundColor: [look.backgroundColor, rest.backgroundColor], color: [look.color, rest.color], zIndex: ["1", "1"] }, spring());
    }
  };

  useLayoutEffect(() => {
    const done = settle.current;
    settle.current = null;
    if (done) land(done);
  }, [order]);
  // A chat switch or the pane shutting mid-drag takes the lifted copy down with it.
  useLayoutEffect(() => () => finish(false), [threadId]);

  const finish = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const el = d.els[d.from]!;
    if (!d.ghost) {
      el.style.translate = "";
      if (d.x) el.animate({ translate: [`${d.x}px 0`, "0 0"] }, spring());
      return;
    }
    const lifted = getComputedStyle(d.ghost);
    const landing: Landing = { key: d.key, at: new Map(d.els.map((tab) => [tab.dataset.paneTab!, tab.getBoundingClientRect().left])), look: { scale: lifted.scale, boxShadow: lifted.boxShadow, backgroundColor: lifted.backgroundColor, color: lifted.color } };
    landing.at.set(d.key, d.left + d.x);
    d.ghost.remove();
    for (const tab of d.els) Object.assign(tab.style, { translate: "", transition: "" });
    delete el.dataset.slot;
    delete document.documentElement.dataset.paneDragging;
    if (escape.current) window.removeEventListener("keydown", escape.current, true);
    if (!commit || d.to === d.from) return land(landing);
    settle.current = landing;
    moveTab(threadId, d.key, d.els.filter((_, i) => i !== d.from)[d.to]?.dataset.paneTab ?? null);
    onSay(t("show.tabMoved", { name: tabs[d.from]!.name, position: d.to + 1, count: tabs.length }));
  };

  const lift = (d: Drag) => {
    const el = d.els[d.from]!;
    el.style.translate = "";
    const box = el.getBoundingClientRect();
    const rest = getComputedStyle(el);
    const from = { boxShadow: rest.boxShadow, backgroundColor: rest.backgroundColor, color: rest.color };
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-pane-tab");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.dataset.ghost = "";
    Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, translate: `${d.x}px 0` });
    // The label keeps the press dip of the tab it copies, so neither the lift nor the drop resizes it.
    ghost.querySelector<HTMLElement>('[role="tab"]')!.style.scale = getComputedStyle(el.querySelector('[role="tab"]')!).scale;
    document.body.append(ghost);
    const up = getComputedStyle(ghost);
    ghost.animate({ scale: ["1", String(LIFT_SCALE)], boxShadow: [from.boxShadow, LIFT_SHADOW], backgroundColor: [from.backgroundColor, up.backgroundColor], color: [from.color, up.color] }, { duration: reducedMotion() ? 0 : MOTION_MODERATE_MS, easing: EASE_STANDARD });
    d.ghost = ghost;
    d.left = box.left;
    el.dataset.slot = "";
    for (const tab of d.els) if (tab !== el) tab.style.transition = reducedMotion() ? "none" : `translate ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
    document.documentElement.dataset.paneDragging = "";
    escape.current = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    window.addEventListener("keydown", escape.current, true);
  };

  const down = (tab: TabView) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === "touch" || !row.current || (event.target as HTMLElement).closest("[data-tab-close]")) return;
    const els = Array.from(row.current.querySelectorAll<HTMLElement>("[data-pane-tab]"));
    const from = els.findIndex((el) => el.dataset.paneTab === tab.key);
    const { scrollLeft, clientWidth } = row.current;
    drag.current = { key: tab.key, id: event.pointerId, x0: event.clientX, x: 0, from, to: from, els, lefts: els.map((el) => el.offsetLeft), widths: els.map((el) => el.offsetWidth), view: [scrollLeft, scrollLeft + clientWidth], left: 0 };
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    const last = d.els.length - 1;
    const w = d.widths[d.from]!;
    const home = d.lefts[d.from]!;
    // A row that scrolls ends where it is cut off, not where its hidden tabs end.
    d.x = soften(event.clientX - d.x0, [Math.max(d.lefts[0]!, d.view[0]) - home - 8, Math.min(d.lefts[last]! + d.widths[last]!, d.view[1]) - w - home + 8]);
    if (!d.ghost) {
      if (Math.abs(event.clientX - d.x0) < 4) {
        d.els[d.from]!.style.translate = `${d.x}px 0`;
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      lift(d);
    }
    d.ghost!.style.translate = `${d.x}px 0`;
    // A neighbor gives way once the tab's leading edge passes its middle, not once the tab covers it.
    const lead = home + d.x;
    const to = d.lefts.filter((left, i) => i !== d.from && (i < d.from ? lead : lead + w) > left + d.widths[i]! / 2).length;
    if (to === d.to) return;
    d.to = to;
    d.els.forEach((el, i) => {
      const shift = d.from < to && i > d.from && i <= to ? -w : to < d.from && i >= to && i < d.from ? w : 0;
      if (i !== d.from) el.style.translate = shift ? `${shift}px 0` : "";
    });
  };

  const nudge = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!event.altKey || !event.shiftKey || !step) return;
    event.preventDefault();
    const at = index + step;
    const tab = tabs[index]!;
    if (at < 0 || at >= tabs.length) return;
    moveTab(threadId, tab.key, tabs.filter((_, i) => i !== index)[at]?.key ?? null);
    onSay(t("show.tabMoved", { name: tab.name, position: at + 1, count: tabs.length }));
  };

  return (
    <>
      {tabs.map((tab, index) => {
        const Icon = tab.icon;
        const on = tab.key === active;
        return (
          <div key={tab.key} data-pane-tab={tab.key} data-selected={on || undefined} className="show-pane-tab" onPointerDown={down(tab)} onPointerMove={move} onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onPointerLeave={() => { if (!drag.current?.ghost) finish(false); }}>
            <button type="button" role="tab" aria-selected={on} onClick={() => onOpen(tab.entry)} onKeyDown={(event) => nudge(event, index)}>
              <Icon size={13} aria-hidden className="shrink-0" />
              <span>{tab.name}</span>
            </button>
            <button type="button" data-tab-close className="show-pane-tab-close" aria-label={t("show.closeTab", { name: tab.name })} title={t("show.closeTab", { name: tab.name })} onClick={() => onClose(tab, index)}><X size={12} /></button>
          </div>
        );
      })}
    </>
  );
}

export function usePaneWidth() {
  return useState<number | undefined>(() => {
    try {
      const px = Number(globalThis.localStorage?.getItem(PANE_WIDTH_KEY));
      return px >= PANE_MIN ? px : undefined;
    } catch {
      return undefined;
    }
  });
}

/** The pane's left edge: drag or arrow keys to resize, double-click for the default. The width is kept per PC. */
export function PaneEdge({ pane, width, onWidth }: { pane: RefObject<HTMLElement | null>; width?: number; onWidth: (px: number | undefined) => void }) {
  const { t } = useI18n();
  const drag = useRef<{ id: number; x0: number; w0: number; max: number; px: number; frame: number } | null>(null);
  const [held, setHeld] = useState(false);
  const room = () => Math.max(PANE_MIN, (pane.current?.closest<HTMLElement>(".verify-watch-dock")?.clientWidth ?? window.innerWidth) - CHAT_MIN);
  const write = (px: number | undefined) => {
    if (px === undefined) pane.current?.style.removeProperty("--pane-width");
    else pane.current?.style.setProperty("--pane-width", `${px}px`);
  };
  const keep = (px: number | undefined) => {
    try {
      if (px === undefined) localStorage.removeItem(PANE_WIDTH_KEY);
      else localStorage.setItem(PANE_WIDTH_KEY, String(px));
    } catch {
      // Storage blocked: the width lasts until the app closes.
    }
    onWidth(px);
  };
  const end = (commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    setHeld(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    delete document.documentElement.dataset.paneDragging;
    if (!commit) return write(width);
    write(d.px);
    keep(d.px);
  };
  // The pane shutting mid-drag still hands back the cursor and text selection.
  useEffect(() => () => end(false), []);
  useEffect(() => {
    if (!held) return;
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      end(false);
    };
    const blur = () => end(false);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  });
  return (
    <div
      data-pane-edge
      data-drag={held || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || !pane.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const w0 = Math.round(pane.current.getBoundingClientRect().width);
        drag.current = { id: event.pointerId, x0: event.clientX, w0, max: room(), px: w0, frame: 0 };
        setHeld(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.documentElement.dataset.paneDragging = "";
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || event.pointerId !== d.id) return;
        d.px = Math.round(Math.max(PANE_MIN, Math.min(d.max, d.w0 + d.x0 - event.clientX)));
        d.frame ||= requestAnimationFrame(() => {
          d.frame = 0;
          write(d.px);
        });
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(true)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.key === "ArrowLeft" ? STEP : event.key === "ArrowRight" ? -STEP : 0;
        if (!step || !pane.current) return;
        event.preventDefault();
        const px = Math.round(Math.max(PANE_MIN, Math.min(room(), pane.current.getBoundingClientRect().width + step)));
        write(px);
        keep(px);
      }}
      onDoubleClick={() => {
        write(undefined);
        keep(undefined);
      }}
      className="show-pane-edge absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize touch-none"
    >
      {/* Focus sits on the grip, so its ring hugs the grip instead of running the pane's full height. */}
      <div role="separator" aria-orientation="vertical" aria-label={t("show.resizePane")} tabIndex={0} aria-valuenow={width} aria-valuemin={PANE_MIN} className="show-pane-grip" />
    </div>
  );
}
