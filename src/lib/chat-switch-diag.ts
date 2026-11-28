// CHAT-JUMP: something moves a window off the chat it has open and no log
// says what. Each switch away from an open chat posts one [chat-switch] line
// to the server log: the action that did it, the code that dispatched it, and
// the input event (if any) it ran under. Drop this once the trigger is known.
import type { Action } from "@/state/store-types";
import { backDepth } from "./back-navigation";
import { isBottomFollowScroll } from "./bottom-follow";
import { isPhone } from "./phone-swipe";

export const CHAT_SWITCH_PATH = "/api/diag/chat-switch";

type Caller = { event?: string; trusted?: boolean; active?: boolean; caller: string[] };

const callers = new WeakMap<Action, Caller>();
const reported = new WeakSet<Action>();
let lastSwitch = 0;
let switches = 0;

/** At dispatch time, while the caller and its event are still on the stack. */
export function noteDispatch(action: Action) {
  if (action.type !== "select") return;
  const event = typeof window === "undefined" ? undefined : window.event;
  callers.set(action, {
    event: event?.type,
    trusted: event?.isTrusted,
    active: typeof navigator === "undefined" ? undefined : navigator.userActivation?.isActive,
    caller: (new Error().stack ?? "").split("\n").slice(2, 8).map((line) => line.trim().slice(0, 200)),
  });
}

/** Called by the reducer when `action` moved the open chat; StrictMode's second run is dropped. */
export function reportChatSwitch(action: Action, from: string, to: string | undefined, send = postChatSwitch) {
  if (reported.has(action)) return;
  reported.add(action);
  lastSwitch = performance.now();
  switches++;
  send({
    from,
    // a delete that leaves no chat open still logs; the server requires "to"
    to: to ?? "",
    action: action.type,
    ...callers.get(action),
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    desktop: Boolean(window.ogb),
    userAgent: navigator.userAgent.slice(0, 512),
  });
}

// PHONE-FREEZE: taps in the chat column stop doing anything until the app is left and reopened. Three taps in
// a row with no click, focus or scroll after them post one [dead-taps] line; a live tap re-arms it.
const DEAD_TAPS = 3;
const TAP_SLOP = 10;
// under the message menu's hold, so a long press that opens it never counts
const TAP_MAX_MS = 450;
const TAP_SETTLE_MS = 600;
// a tap that stops a glide gets no click
const GLIDE_STOP_MS = 150;

type Tap = { x: number; y: number; target: EventTarget | null; events: Event[]; live: boolean; switches: number; timer: ReturnType<typeof setTimeout> };

/** Phone only and log only: watches touches that start over `zone`'s box and changes nothing they do. */
export function watchDeadTaps(zone: () => Element | null, send = postChatSwitch, phone = isPhone): () => void {
  let start: { x: number; y: number; at: number; event: Event; switches: number } | null = null;
  let tap: Tap | null = null;
  let dead = 0;
  let sent = false;
  let armed = switches;
  let scrolled = -Infinity;
  // a layer over the chat, the bare column or stage box, or an inert page still gets the click
  const onPage = (node: EventTarget | null) => {
    const page = node instanceof Element ? node.closest("[data-phone-chat-page]") : null;
    return Boolean(page && !page.closest("[inert]") && zone()?.contains(page));
  };
  const settle = () => {
    const done = tap;
    tap = null;
    // a chat switch re-arms, so menu and drawer taps never spend the line before a freeze
    if (armed !== switches) {
      armed = switches;
      dead = 0;
      sent = false;
    }
    if (!done) return;
    clearTimeout(done.timer);
    if (done.switches !== switches) return;
    if (done.live) {
      dead = 0;
      sent = false;
      return;
    }
    if (++dead < DEAD_TAPS || sent) return;
    sent = true;
    send(deadTapLine(done, dead, zone()));
  };
  const onStart = (event: TouchEvent) => {
    settle();
    // synthetic touch events can come without touch lists
    const touch = event.touches?.[0];
    const box = zone()?.getBoundingClientRect();
    const over = touch && box && touch.clientX >= box.left && touch.clientX <= box.right && touch.clientY >= box.top && touch.clientY <= box.bottom;
    start = event.touches?.length === 1 && touch && over && phone()
      ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp, event, switches }
      : null;
  };
  const onEnd = (event: TouchEvent) => {
    const began = start;
    start = null;
    const touch = event.changedTouches?.[0];
    if (!began || !touch || scrolled > began.at - GLIDE_STOP_MS || event.timeStamp - began.at > TAP_MAX_MS || Math.hypot(touch.clientX - began.x, touch.clientY - began.y) > TAP_SLOP) return;
    tap = { x: touch.clientX, y: touch.clientY, target: began.event.target, events: [began.event, event], live: false, switches: began.switches, timer: setTimeout(settle, TAP_SETTLE_MS) };
  };
  const onLive = (event: Event) => {
    if (tap && onPage(event.target)) tap.live = true;
  };
  const onScroll = (event: Event) => {
    if (isBottomFollowScroll(event)) return;
    scrolled = event.timeStamp;
    onLive(event);
  };
  const onCancel = () => {
    start = null;
  };
  document.addEventListener("touchstart", onStart, { capture: true, passive: true });
  document.addEventListener("touchend", onEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", onCancel, { capture: true, passive: true });
  for (const name of ["click", "focusin"]) document.addEventListener(name, onLive, { capture: true, passive: true });
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    if (tap) clearTimeout(tap.timer);
    document.removeEventListener("touchstart", onStart, true);
    document.removeEventListener("touchend", onEnd, true);
    document.removeEventListener("touchcancel", onCancel, true);
    for (const name of ["click", "focusin"]) document.removeEventListener(name, onLive, true);
    document.removeEventListener("scroll", onScroll, true);
  };
}

function describeNode(node: Element | null | undefined): string {
  if (!node) return "";
  const data = Object.keys(node instanceof HTMLElement ? node.dataset : {}).slice(0, 3).map((key) => `[${key}]`).join("");
  return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${data}`.slice(0, 120);
}

function describePath(node: Element | null): string[] {
  const path: string[] = [];
  for (let at = node; at && path.length < 10; at = at.parentElement) {
    const style = getComputedStyle(at);
    const flags = [at.hasAttribute("inert") && "inert", style.pointerEvents === "none" && "no-pointer", style.zIndex !== "auto" && `z${style.zIndex}`].filter(Boolean).join(",");
    path.push(`${describeNode(at)}${flags ? ` {${flags}}` : ""}`.slice(0, 120));
  }
  return path;
}

function describeMotion(node: Element | null | undefined): string {
  if (!(node instanceof HTMLElement)) return "";
  const animations = node.getAnimations?.() ?? [];
  return `${node.style.transform || "none"} ${animations.map((animation) => `${animation.playState}@${Math.round(Number(animation.currentTime ?? -1))}`).join(" ")}`.trim().slice(0, 200);
}

function deadTapLine(tap: Tap, taps: number, root: Element | null) {
  const hit = document.elementFromPoint(tap.x, tap.y);
  const viewport = window.visualViewport;
  return {
    kind: "dead-taps",
    taps,
    hit: describeNode(hit),
    path: describePath(hit),
    target: describeNode(tap.target instanceof Element ? tap.target : null),
    targetPath: describePath(tap.target instanceof Element ? tap.target : null),
    onTarget: Boolean(hit && tap.target instanceof Node && (hit === tap.target || hit.contains(tap.target) || tap.target.contains(hit))),
    prevented: tap.events.filter((event) => event.defaultPrevented).map((event) => event.type),
    active: describeNode(document.activeElement),
    stage: describeMotion(root?.querySelector("[data-phone-chat-page]")?.parentElement),
    rider: describeMotion(document.querySelector("[data-phone-menu]")),
    idle: document.documentElement.getAttribute("data-orbit-idle") ?? "",
    held: [...document.querySelectorAll("[data-closing], [data-sheet-moving], [inert]")].slice(0, 10).map(describeNode),
    back: Math.min(backDepth(history.state), 1000),
    viewport: `${Math.round(viewport?.width ?? 0)}x${Math.round(viewport?.height ?? 0)}+${Math.round(viewport?.offsetTop ?? 0)} ${window.innerWidth}x${window.innerHeight}`,
    build: document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.getAttribute("src")?.slice(0, 80) ?? "",
    sinceSwitch: lastSwitch ? Math.round(performance.now() - lastSwitch) : -1,
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    userAgent: navigator.userAgent.slice(0, 512),
  };
}

function postChatSwitch(line: Record<string, unknown>) {
  setTimeout(() => {
    void fetch(CHAT_SWITCH_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(line), keepalive: true }).catch(() => {});
  }, 0);
}
