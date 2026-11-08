import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { reducedMotion } from "./phone-swipe";
import { useTouchDrag } from "./use-touch-drag";

const KEY = "openmausbot.usageOrder.v1";
const CHANGE = "usage-order";
type Orders = Record<string, string[]>;
const ROW = "[data-account-row]";
const SECTION = "[data-usage-engine]";
const GRIP = "[data-usage-grip]";
const PRESSABLE = `${GRIP}, ${ROW}, [data-engine-head]`;
const EDGE = 48;
const STEP = 10;

function load(): Orders {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((id) => typeof id === "string"))) : {};
  } catch { return {}; }
}

export function readUsageOrder(base: string) {
  return load()[base];
}

export function ordered<T>(items: T[], order: string[] = [], id: (item: T) => string): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((a, b) => (rank.get(id(a)) ?? order.length) - (rank.get(id(b)) ?? order.length));
}

type Drag = {
  node: HTMLElement; items: HTMLElement[]; rects: DOMRect[]; from: number; to: number; key: string; y: number; dy: number; scrollTop: number;
};

function scrollParent(node: HTMLElement | null) {
  for (let each = node; each; each = each.parentElement) if (/auto|scroll/.test(getComputedStyle(each).overflowY)) return each;
  return null;
}

export function useUsageDrag(engines: { base: string; accounts: { id: string }[] }[]) {
  const [orders, setOrders] = useState(load);
  const latest = useRef(orders);
  latest.current = orders;
  useEffect(() => {
    const changed = (event: Event) => { if (event instanceof CustomEvent) setOrders(event.detail); };
    const stored = (event: StorageEvent) => { if (event.key === KEY || event.key === null) setOrders(load()); };
    window.addEventListener(CHANGE, changed);
    window.addEventListener("storage", stored);
    return () => { window.removeEventListener(CHANGE, changed); window.removeEventListener("storage", stored); };
  }, []);
  const active = useRef<Drag | null>(null);
  const list = useRef<HTMLElement | null>(null);
  const unbind = useRef(() => {});
  const identify = (node: HTMLElement) => node.dataset.accountRow ?? node.dataset.usageBase!;
  const siblings = (node: HTMLElement) => {
    const account = node.matches(ROW);
    const scope = account ? node.closest(SECTION)! : list.current!;
    return [...scope.querySelectorAll<HTMLElement>(account ? ROW : SECTION)].filter((item) => !item.closest("[aria-hidden='true']"));
  };
  const clean = (drag: Drag) => {
    for (const node of drag.items) {
      node.style.removeProperty("translate");
      node.style.removeProperty("transition");
      node.removeAttribute("data-usage-lifted");
    }
  };
  const commit = (drag: Drag) => {
    if (drag.from === drag.to) return;
    const ids = drag.items.map(identify);
    ids.splice(drag.to, 0, ids.splice(drag.from, 1)[0]!);
    const accounts = engines.find((engine) => engine.base === drag.key)?.accounts;
    const before = latest.current;
    const visible = new Set(ids);
    let index = 0;
    const order = accounts ? ordered(accounts, before[drag.key], (account) => account.id)
      .map((account) => visible.has(account.id) ? ids[index++]! : account.id) : ids;
    const next = { ...before, [drag.key]: order };
    setOrders(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Keep the session order. */ }
    window.dispatchEvent(new CustomEvent(CHANGE, { detail: next }));
  };
  const focus = (drag: Drag) => {
    const selector = drag.node.matches(ROW) ? ROW : SECTION;
    const node = [...list.current?.querySelectorAll<HTMLElement>(selector) ?? []].find((each) => identify(each) === identify(drag.node));
    node?.querySelector<HTMLElement>("[data-usage-grip]")?.focus({ preventScroll: true });
  };
  const lift = (pressed: HTMLElement) => {
    const node = pressed.closest<HTMLElement>(`${ROW}, ${SECTION}`);
    if (!node || active.current) return null;
    const items = siblings(node);
    const from = items.indexOf(node);
    active.current = { node, items, rects: items.map((item) => item.getBoundingClientRect()), from, to: from,
      key: node.matches(ROW) ? node.closest<HTMLElement>(SECTION)!.dataset.usageBase! : "engines", y: 0, dy: 0, scrollTop: scrollParent(list.current)?.scrollTop ?? 0 };
    node.setAttribute("data-usage-lifted", "");
    return node;
  };
  const over = (_target: Element | null, y: number) => {
    const drag = active.current;
    if (!drag) return null;
    drag.dy = y - drag.y + (scrollParent(list.current)?.scrollTop ?? 0) - drag.scrollTop;
    const own = drag.rects[drag.from]!;
    const center = own.top + own.height / 2 + drag.dy;
    let to = drag.from;
    drag.rects.forEach((rect, index) => {
      if (index < drag.from && center < rect.top + rect.height / 2) to = Math.min(to, index);
      if (index > drag.from && center > rect.top + rect.height / 2) to = Math.max(to, index);
    });
    drag.to = to;
    const gap = drag.rects[1] ? drag.rects[1]!.top - drag.rects[0]!.bottom : 0;
    drag.items.forEach((item, index) => {
      if (item === drag.node) return;
      const offset = index > drag.from && index <= to ? -(own.height + gap)
        : index < drag.from && index >= to ? own.height + gap : 0;
      item.style.transition = reducedMotion() ? "none" : "translate 170ms ease-out";
      item.style.translate = `0 ${offset}px`;
    });
    return null;
  };
  const drop = () => {
    const drag = active.current;
    if (!drag) return;
    const own = drag.rects[drag.from]!;
    const dest = drag.rects[drag.to]!;
    const offset = drag.to > drag.from ? dest.bottom - own.bottom : dest.top - own.top;
    const finish = () => {
      clean(drag);
      flushSync(() => commit(drag));
      active.current = null;
      focus(drag);
    };
    if (reducedMotion() || !drag.node.animate) { finish(); return; }
    drag.node.style.removeProperty("translate");
    const animation = drag.node.animate([
      { translate: `0 ${drag.dy}px`, scale: "1.03", boxShadow: getComputedStyle(drag.node).boxShadow, backgroundColor: getComputedStyle(drag.node).backgroundColor },
      { translate: `0 ${offset}px`, scale: "1", boxShadow: "none", backgroundColor: "transparent" },
    ], { duration: 220, easing: "cubic-bezier(0.16,1,0.3,1)", fill: "forwards" });
    animation.finished.then(() => { finish(); animation.cancel(); }, () => { clean(drag); active.current = null; });
  };
  const cancel = () => {
    if (active.current) clean(active.current);
    active.current = null;
  };
  const touchRef = useTouchDrag(PRESSABLE, `${SECTION}, ${ROW}`, {
    quick: GRIP,
    skip: `button:not(${GRIP}, [data-edit-name]), a, input`,
    selectPressed: true,
    scroller: () => scrollParent(list.current),
    // the grip's touch area overlaps the start of the name, which keeps its own tap
    tap: (x, y) => document.elementsFromPoint(x, y).find((each) => !each.closest(GRIP))?.closest<HTMLElement>("button")?.click(),
    lift: (pressed) => {
      const node = lift(pressed);
      if (node && active.current) active.current.y = touchY.current;
      return node;
    }, over, drop, cancel,
  });
  const touchY = useRef(0);
  const ref = useCallback((node: HTMLElement | null) => { list.current = node; touchRef(node); }, [touchRef]);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    touchY.current = event.clientY;
    if (!(event.target instanceof Element) || !event.target.closest(GRIP)) return;
    if (event.pointerType === "touch" || event.button !== 0) return;
    const node = lift(event.target.closest<HTMLElement>(GRIP)!);
    if (!node || !active.current) return;
    event.preventDefault();
    active.current.y = event.clientY;
    let pointerY = event.clientY;
    let frame = 0;
    const place = () => {
      if (!active.current) return;
      over(null, pointerY);
      node.style.translate = `0 ${active.current.dy}px`;
    };
    const edge = () => {
      const box = scrollParent(list.current);
      if (box && active.current) {
        const rect = box.getBoundingClientRect();
        const before = box.scrollTop;
        box.scrollTop += pointerY < rect.top + EDGE ? -STEP : pointerY > rect.bottom - EDGE ? STEP : 0;
        if (box.scrollTop !== before) place();
      }
      frame = requestAnimationFrame(edge);
    };
    const move = (next: globalThis.PointerEvent) => { pointerY = next.clientY; place(); };
    frame = requestAnimationFrame(edge);
    const end = () => { unbind.current(); drop(); };
    const abort = () => { unbind.current(); cancel(); };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", abort, { once: true });
    unbind.current = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", abort);
      cancelAnimationFrame(frame);
    };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key) || !(event.target instanceof Element)) return;
    const pressed = event.target.closest<HTMLElement>("[data-usage-grip]");
    if (!pressed || !lift(pressed) || !active.current) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = active.current;
    drag.to = Math.max(0, Math.min(drag.items.length - 1, drag.from + (event.key === "ArrowDown" ? 1 : -1)));
    const rects = drag.rects;
    flushSync(() => commit(drag));
    if (!reducedMotion()) drag.items.forEach((item, index) => {
      const dy = rects[index]!.top - item.getBoundingClientRect().top;
      if (dy) item.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 220, easing: "ease-out" });
    });
    clean(drag);
    active.current = null;
    focus(drag);
  };
  useEffect(() => () => { unbind.current(); cancel(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { orders, ref, onPointerDown, onKeyDown };
}
