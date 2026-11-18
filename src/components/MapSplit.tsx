import { useEffect, useRef, type RefObject } from "react";
import { useI18n } from "@/lib/i18n";

const copy = { en: { code: "Resize the code view", rows: "Resize the file tree" }, ko: { code: "코드 보기 크기 조절", rows: "파일 트리 크기 조절" } };
const KEY = "omb-map-split";
const ROWS = "omb-map-rows";
const REST = 120;
const STEP = 24;
type Box = { tree: number; min: number; full: number; free: number; flow?: HTMLElement; tall: number; shrink: number; grow: number };
type Placed = { tree: number; rows: number };

// rows: the line above the Git rows, which give or take what the tree gains or loses.
// The other line moves only the Git rows and the code; when the rows can neither grow nor shrink, the move goes to the tree.
export function MapSplit({ target, rows = false }: { target: RefObject<HTMLElement | null>; rows?: boolean }) {
  const { locale } = useI18n();
  const drag = useRef<Box & { y: number; at: Placed; split: string; touched: { tree: boolean; rows: boolean }; frame: number } | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY));
    if (saved > 0) target.current?.style.setProperty("--map-split", `${saved}%`);
    const share = rows ? Number(localStorage.getItem(ROWS)) : 0;
    if (share > 0) target.current?.parentElement?.style.setProperty("--map-rows", `${share}%`);
  }, [target, rows]);

  // Read once per drag: every later move only writes the size variables.
  const bounds = (handle: HTMLElement): Box | null => {
    const top = target.current;
    if (!top) return null;
    const near = rows ? handle.nextElementSibling : handle.previousElementSibling;
    const flow = near instanceof HTMLElement && near.matches(".map-flow-rows") ? near : undefined;
    const list = flow?.querySelector<HTMLElement>(".map-flow-list");
    if (flow ? !list : rows) return null;
    const row = list?.firstElementChild?.getBoundingClientRect().height ?? 0;
    const room = handle.parentElement?.querySelector<HTMLElement>(":scope > .map-code")?.clientHeight ?? 0;
    // No code view below: the rows box fills the pane, and the room under its list is give too.
    const pad = flow && getComputedStyle(flow);
    const empty = flow && list && pad && !flow.nextElementSibling ? Math.max(0, flow.clientHeight - (Number.parseFloat(pad.paddingTop) || 0) - (Number.parseFloat(pad.paddingBottom) || 0) - list.offsetHeight) : 0;
    return {
      tree: top.getBoundingClientRect().height, min: Number.parseFloat(getComputedStyle(top).minHeight) || 0, full: top.scrollHeight + top.offsetHeight - top.clientHeight,
      // The rows keep one row, take back only what they hide, and never take the code view under REST.
      free: Math.max(0, room - REST), flow, tall: flow?.getBoundingClientRect().height ?? 0, shrink: list ? Math.max(0, list.clientHeight - row) + empty : 0, grow: list ? list.scrollHeight - list.clientHeight : 0,
    };
  };
  const place = (box: Box, by: number): Placed => {
    const down = by > 0, size = Math.abs(by), sign = down ? 1 : -1;
    const give = down === rows ? box.shrink : box.grow;
    const tree = Math.max(0, down ? box.full - box.tree : box.tree - box.min);
    const code = down ? box.free : Infinity;
    if (rows) {
      const moved = Math.min(size, tree, give > 0 ? give : code);
      return { tree: box.tree + sign * moved, rows: give > 0 ? box.tall - sign * moved : box.tall };
    }
    if (box.shrink || box.grow) return { tree: box.tree, rows: box.tall + sign * Math.min(size, give, code) };
    return { tree: box.tree + sign * Math.min(size, tree, code), rows: box.tall };
  };
  const keep = (box: Box, at: Placed) => {
    const top = target.current;
    const pane = top?.parentElement;
    if (!top || !pane?.clientHeight) return;
    const share = (height: number) => (height / pane.clientHeight * 100).toFixed(1);
    if (at.tree !== box.tree) {
      top.style.setProperty("--map-split", `${share(at.tree)}%`);
      localStorage.setItem(KEY, share(at.tree));
    }
    // Rows with no code view below fill the free room: their filled height is not a size to remember.
    if (box.flow?.nextElementSibling && at.rows !== box.tall) {
      pane.style.setProperty("--map-rows", `${share(at.rows)}%`);
      localStorage.setItem(ROWS, share(at.rows));
    }
  };
  // The rows and the code move as layers while dragging: without it every frame repaints them.
  const lift = (handle: HTMLElement, on: boolean) => {
    for (const part of handle.parentElement?.children ?? []) if (part !== target.current && part instanceof HTMLElement) part.style.willChange = on ? "transform" : "";
  };
  const end = (handle: HTMLElement) => {
    const now = drag.current;
    if (!now) return;
    drag.current = null;
    cancelAnimationFrame(now.frame);
    handle.removeAttribute("data-drag");
    lift(handle, false);
    // A drag that comes back to its start keeps the tree's share, not the last frame's pixels.
    target.current?.style.setProperty("--map-split", now.split);
    now.flow?.style.removeProperty("--map-rows");
    keep(now, now.at);
  };

  return <div role="separator" aria-orientation="horizontal" aria-label={copy[locale][rows ? "rows" : "code"]} tabIndex={0} data-rows={rows || undefined}
    className="map-split relative z-[2] -my-[3px] h-1.5 shrink-0 cursor-row-resize touch-none hover:bg-accent/40 focus-visible:bg-accent/60 data-[drag]:bg-accent/60"
    onPointerDown={event => {
      const box = event.button === 0 && bounds(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.currentTarget.setAttribute("data-drag", "");
      lift(event.currentTarget, true);
      drag.current = { ...box, y: event.clientY, at: { tree: box.tree, rows: box.tall }, split: target.current?.style.getPropertyValue("--map-split") ?? "", touched: { tree: false, rows: false }, frame: 0 };
    }}
    onPointerMove={event => {
      const now = drag.current;
      if (!now) return;
      now.at = place(now, event.clientY - now.y);
      now.frame ||= requestAnimationFrame(() => {
        now.frame = 0;
        now.touched.tree ||= now.at.tree !== now.tree;
        now.touched.rows ||= now.at.rows !== now.tall;
        if (now.touched.tree) target.current?.style.setProperty("--map-split", `${now.at.tree}px`);
        if (now.touched.rows) now.flow?.style.setProperty("--map-rows", `${now.at.rows}px`);
      });
    }}
    onPointerUp={event => end(event.currentTarget)}
    onPointerCancel={event => end(event.currentTarget)}
    onLostPointerCapture={event => end(event.currentTarget)}
    onKeyDown={event => {
      const by = event.key === "ArrowDown" ? STEP : event.key === "ArrowUp" ? -STEP : 0;
      const box = by && bounds(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      keep(box, place(box, by));
    }}
  />;
}
