import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { usageIdentity } from "../../shared/usage-identity";
import { reducedMotion, SWIPE_MOTION_MS, SWIPE_SPRING } from "./phone-swipe";
import { LIFT_SCALE, soften, travel, useTouchDrag, type Travel } from "./use-touch-drag";

const KEY = "openmausbot.usageOrder.v1";
const CHANGE = "usage-order";
type Orders = Record<string, string[]>;
const ROW = "[data-account-row]";
const SECTION = "[data-usage-engine]";
const PRESSABLE = "[data-usage-reorder]";
// a press on a row's own button is a click, never a pickup, for mouse and touch alike
const SKIP = "button:not([data-edit-name], [data-engine-fold]), [data-account-name-editor], input, a, code";
const DRAGGING = "data-usage-dragging";
const EDGE = 48;
const STEP = 10;
const SLOP = 4;

export const reorderable = (label: string) => ({
  "data-usage-reorder": "", role: "group", tabIndex: 0, "aria-label": label, "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
});

function load(): Orders {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((id) => typeof id === "string"))) : {};
  } catch { return {}; }
}

export function ordered<T>(items: T[], order: string[] = [], id: (item: T) => string): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((a, b) => (rank.get(id(a)) ?? order.length) - (rank.get(id(b)) ?? order.length));
}

type Instance = { instanceId: string; snapshot: Parameters<typeof usageIdentity>[0] };
type Place = { id?: string; identity?: string };
const IDENTITY = "identity:";
const normal = (identity: string) => identity.trim().toLowerCase();

// a sign-out discards an added slot and its re-add gets a new id, so a saved place also names who the account signs in as,
// lowercased as the server's identity is: a re-add in another case is the same account. null is signed out, undefined not checked yet
function identityOf(id: string, instances: Instance[]) {
  const identity = usageIdentity(instances.find((each) => each.instanceId === id)?.snapshot ?? {});
  return identity === null ? null : identity && normal(identity) || undefined;
}

// an earlier build saved the email as typed, so saved identities read the way incoming ones do
function places(order: string[]): Place[] {
  const list: Place[] = [];
  for (const key of order) {
    const last = list.at(-1);
    if (!key.startsWith(IDENTITY)) list.push({ id: key });
    else if (last?.id !== undefined && last.identity === undefined) last.identity = normal(key.slice(IDENTITY.length));
    else list.push({ identity: normal(key.slice(IDENTITY.length)) });
  }
  return list;
}

const keys = (list: Place[]) => list.flatMap(({ id, identity }) => [...id === undefined ? [] : [id], ...identity === undefined ? [] : [IDENTITY + identity]]);

// each place holds one slot, so two slots signed in as one email keep their own places
function claim(ids: string[], list: Place[], instances: Instance[]) {
  const identities = ids.map((id) => identityOf(id, instances));
  const at: (number | undefined)[] = ids.map(() => undefined);
  const taken = new Set<number>();
  const pass = (fits: (place: Place, index: number) => boolean) => ids.forEach((_, index) => {
    if (at[index] !== undefined) return;
    const found = list.findIndex((place, slot) => !taken.has(slot) && fits(place, index));
    if (found >= 0) { at[index] = found; taken.add(found); }
  });
  pass((place, index) => place.id === ids[index]);
  pass((place, index) => !!identities[index] && place.identity === identities[index]);
  // a slot still checking may be the account that left a place, so it holds that place until its email arrives; a new account then goes last
  pass((place, index) => identities[index] === undefined && place.identity !== undefined);
  return at;
}

export function rankAccounts<T>(accounts: T[], order: string[] = [], id: (account: T) => string, instances: Instance[]): T[] {
  const at = claim(accounts.map(id), places(order), instances);
  return accounts.map((account, index) => ({ account, place: at[index] ?? order.length })).sort((a, b) => a.place - b.place).map(({ account }) => account);
}

type Drag = {
  node: HTMLElement; items: HTMLElement[]; rects: DOMRect[]; from: number; to: number; key: string; y: number; dy: number; scrollTop: number; travel: Travel;
};

function scrollParent(node: HTMLElement | null) {
  for (let each = node; each; each = each.parentElement) if (/auto|scroll/.test(getComputedStyle(each).overflowY)) return each;
  return null;
}

export function useUsageDrag(engines: { base: string; accounts: { id: string }[] }[], instances: Instance[]) {
  const [orders, setOrders] = useState(load);
  const latest = useRef(orders);
  latest.current = orders;
  const named = (ids: string[]) => keys(ids.map((id) => ({ id, identity: identityOf(id, instances) ?? undefined })));
  const save = (next: Orders) => {
    setOrders(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Keep the session order. */ }
    window.dispatchEvent(new CustomEvent(CHANGE, { detail: next }));
  };
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
    document.documentElement.removeAttribute(DRAGGING);
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
    const order = accounts ? rankAccounts(accounts, before[drag.key], (account) => account.id, instances)
      .map((account) => visible.has(account.id) ? ids[index++]! : account.id) : ids;
    save({ ...before, [drag.key]: accounts ? named(order) : order });
  };
  const focus = (drag: Drag) => {
    const selector = drag.node.matches(ROW) ? ROW : SECTION;
    const node = [...list.current?.querySelectorAll<HTMLElement>(selector) ?? []].find((each) => identify(each) === identify(drag.node));
    (node?.matches(PRESSABLE) ? node : node?.querySelector<HTMLElement>(PRESSABLE))?.focus({ preventScroll: true });
  };
  const lift = (pressed: HTMLElement) => {
    const node = pressed.closest<HTMLElement>(`${ROW}, ${SECTION}`);
    if (!node || active.current) return null;
    const items = siblings(node);
    const from = items.indexOf(node);
    active.current = { node, items, rects: items.map((item) => item.getBoundingClientRect()), from, to: from,
      key: node.matches(ROW) ? node.closest<HTMLElement>(SECTION)!.dataset.usageBase! : "engines", y: 0, dy: 0, scrollTop: scrollParent(list.current)?.scrollTop ?? 0, travel: travel(node, scrollParent(list.current)) };
    node.setAttribute("data-usage-lifted", "");
    // the whole page: a lifted row ignores hits, so a long press would land on the text around it
    document.documentElement.setAttribute(DRAGGING, "");
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
      item.style.transition = reducedMotion() ? "none" : `translate ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
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
      { translate: `0 ${soften(drag.dy, drag.travel)}px`, scale: String(LIFT_SCALE), boxShadow: getComputedStyle(drag.node).boxShadow, backgroundColor: getComputedStyle(drag.node).backgroundColor },
      { translate: `0 ${offset}px`, scale: "1", boxShadow: "none", backgroundColor: "transparent" },
    ], { duration: SWIPE_MOTION_MS, easing: SWIPE_SPRING, fill: "forwards" });
    animation.finished.then(() => { finish(); animation.cancel(); }, () => { clean(drag); active.current = null; });
  };
  const cancel = () => {
    if (active.current) clean(active.current);
    active.current = null;
  };
  const touchRef = useTouchDrag(PRESSABLE, `${SECTION}, ${ROW}`, {
    skip: SKIP,
    selectPressed: true,
    scroller: () => scrollParent(list.current),
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
    if (event.pointerType === "touch" || event.button !== 0 || !(event.target instanceof Element) || active.current || event.target.closest(SKIP)) return;
    const pressed = event.target.closest<HTMLElement>(PRESSABLE);
    if (!pressed) return;
    unbind.current();
    const { clientX: startX, clientY: startY } = event;
    let node: HTMLElement | null = null;
    let pointerY = startY;
    let frame = 0;
    const place = () => {
      if (!active.current || !node) return;
      over(null, pointerY);
      node.style.translate = `0 ${soften(active.current.dy, active.current.travel)}px`;
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
    const move = (next: globalThis.PointerEvent) => {
      pointerY = next.clientY;
      if (!node) {
        if (Math.hypot(next.clientX - startX, next.clientY - startY) <= SLOP) return;
        node = lift(pressed);
        if (!node || !active.current) { unbind.current(); return; }
        active.current.y = startY;
        frame = requestAnimationFrame(edge);
      }
      place();
    };
    const end = () => {
      unbind.current();
      if (!node) return;
      drop();
      // the drop lands on the press's own button, whose click would still fire
      const stop = (click: Event) => { click.stopPropagation(); click.preventDefault(); };
      const release = () => document.removeEventListener("click", stop, true);
      document.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(release);
      unbind.current = release;
    };
    const abort = () => { unbind.current(); if (node) cancel(); };
    const noSelect = (start: Event) => start.preventDefault();
    // a double click keeps its word selection
    const second = (down: MouseEvent) => { if (down.detail > 1) unbind.current(); };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", abort, { once: true });
    document.addEventListener("selectstart", noSelect);
    document.addEventListener("mousedown", second, { once: true });
    unbind.current = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", abort);
      document.removeEventListener("selectstart", noSelect);
      document.removeEventListener("mousedown", second);
      cancelAnimationFrame(frame);
    };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key) || !(event.target instanceof HTMLElement) || !event.target.matches(PRESSABLE)) return;
    if (!lift(event.target) || !active.current) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = active.current;
    drag.to = Math.max(0, Math.min(drag.items.length - 1, drag.from + (event.key === "ArrowDown" ? 1 : -1)));
    const rects = drag.rects;
    flushSync(() => commit(drag));
    if (!reducedMotion()) drag.items.forEach((item, index) => {
      const dy = rects[index]!.top - item.getBoundingClientRect().top;
      if (dy) item.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: SWIPE_MOTION_MS, easing: SWIPE_SPRING });
    });
    clean(drag);
    active.current = null;
    focus(drag);
  };
  useEffect(() => () => { unbind.current(); cancel(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { orders, ref, onPointerDown, onKeyDown };
}
