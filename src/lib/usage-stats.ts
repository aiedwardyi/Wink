import type { FEATURES, SCREENS, SETTINGS, StatsEvent } from "../../shared/usage-stats";

// Anonymous usage stats, screen side. Events wait here and go to this PC's server, which owns the switch and the upload.
// No runtime imports: the settings modules call into this one.

type Row = Record<string, unknown>;
type Tracked = Row & { e: StatsEvent["e"] };
type Of<E extends StatsEvent["e"]> = Extract<StatsEvent, { e: E }>;
type Screen = (typeof SCREENS)[number];
type Reply = { engine?: string; model?: string };

const PATH = "/api/stats";
const SWITCH_PATH = "/api/analytics";
const MAX = 500;
const FLUSH_MS = 60_000;
const HOUR = 3_600_000;
export const FIRST_REPLY_KEY = "omb-stats-first";
const WITH_CLIENT = new Set<unknown>(["open", "send", "screen", "setting", "feature", "error", "stall"]);

// undefined while the switch is unknown or the first-run box is still open: events wait and none are sent.
let on: boolean | undefined;
let firstRun = false;
// The PC's name for the stretch since stats last went off; it refuses a batch from an older one.
let period: unknown;
let switches = 0;
let buffer: Tracked[] = [];
const screens = new Map<Screen, number>();
let screenHour = 0;
let readUi: (() => Row) | undefined;
let isPhone = () => false;
let uiChanged = true;
let began = 0;
let nextVia: Of<"switch">["via"] | undefined;
let nextInput: Of<"send">["input"] | undefined;
let sending: { event: Tracked; start: number; threadId: string | undefined; reply: () => Reply } | undefined;
let first: { start?: number; finish?: number; tries: number } | undefined;
let streamDown = 0;
let updater: string | undefined;
const once = new Set<string>();

const since = (start: number) => Math.round(performance.now() - start);
const frame = (run: () => void) => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); };
const painted = (run: () => void) => frame(() => frame(run));
const whole = (value: number | undefined) => (value === undefined ? undefined : Math.max(0, Math.round(value)));

export function track(event: Tracked): void {
  if (on === false || buffer.length >= MAX) return;
  buffer.push(event);
}

export function trackScreen(name: Screen): void {
  if (on !== false) screens.set(name, (screens.get(name) ?? 0) + 1);
}

/** `stored` is the setting's localStorage key: nothing saved there yet means the change is away from the default. */
export function trackSetting(key: keyof typeof SETTINGS, from: string | undefined, to: string, via: Of<"setting">["via"] = "settings", stored?: string): void {
  if (on === false || !from || from === to) return;
  let fresh = false;
  try { fresh = stored !== undefined && localStorage.getItem(stored) === null; } catch { /* No storage: report the value. */ }
  uiChanged = true;
  track({ e: "setting", key, from: fresh ? "default" : from, to, via });
}

export function trackFeature(name: keyof typeof FEATURES, more?: { kind?: string; n?: number; ms?: number }): void {
  track({ e: "feature", name, ...more, ms: whole(more?.ms) });
}

/** For a feature used on every keystroke: counted once per page load. */
export function trackFeatureOnce(name: keyof typeof FEATURES): void {
  if (once.has(name)) return;
  once.add(name);
  trackFeature(name);
}

/** The next switch comes from here, not from the sidebar, the drawer or the model list. */
export function switchVia(via: Of<"switch">["via"]): void {
  nextVia = via;
}

export function takeVia(fallback: Of<"switch">["via"]): Of<"switch">["via"] {
  const via = nextVia ?? fallback;
  nextVia = undefined;
  return via;
}

/** The next send was spoken, not typed. */
export function sendInput(input: Of<"send">["input"]): void {
  nextInput = input;
}

/** `from` and `to` are engine, model or effort ids; a chat switch is timed to its next paint instead. */
export function trackSwitch(what: Of<"switch">["what"], via?: Of<"switch">["via"], from?: string, to?: string): void {
  if (on === false || (what !== "chat" && from === to)) return;
  const event: Tracked = { e: "switch", what, via: via ?? takeVia(isPhone() ? "drawer" : "sidebar"), from, to };
  track(event);
  if (what !== "chat") return;
  const start = performance.now();
  painted(() => { event.ms = since(start); });
}

function settleSend(): void {
  if (sending) track(sending.event);
  sending = undefined;
}

/** `reply` is only read for an install's first reply. */
export function trackSend(threadId: string | undefined, reply: () => Reply = () => ({})): void {
  const input = nextInput ?? "typed";
  nextInput = undefined;
  if (on === false) return;
  settleSend();
  const event: Tracked = { e: "send", input };
  const start = performance.now();
  sending = { event, start, threadId, reply };
  painted(() => { event.bubbleMs = since(start); });
  if (first) saveFirst({ ...first, tries: first.tries + 1 });
}

/** Reply text reached the screen. One check per delta unless a send is waiting on it. */
export function trackReplyText(threadId: string): void {
  if (!sending || sending.threadId !== threadId) return;
  const { event, start, reply } = sending;
  frame(() => {
    event.firstMs = since(start);
    if (sending?.event === event) settleSend();
  });
  const who = first && reply();
  if (!first || !who?.engine) return;
  const now = Date.now();
  const elapsed = (at: number | undefined) => (at === undefined ? undefined : Math.max(0, now - at));
  track({ e: "first_reply", ...who, msStart: elapsed(first.start), msFinish: elapsed(first.finish), tries: Math.min(9, Math.max(1, first.tries)) });
  saveFirst(undefined);
}

function saveFirst(next: typeof first): void {
  first = next;
  try { localStorage.setItem(FIRST_REPLY_KEY, next ? JSON.stringify(next) : "done"); } catch { /* Counted for this page only. */ }
}

function loadFirst(): void {
  try {
    const saved = localStorage.getItem(FIRST_REPLY_KEY);
    if (!saved || saved === "done") return;
    const { start, finish, tries } = JSON.parse(saved) as Record<string, unknown>;
    first = { start: Number(start) || undefined, finish: Number(finish) || undefined, tries: Number(tries) || 0 };
  } catch { /* No storage, no first-reply timing. */ }
}

/** First-run steps wait on this screen until the first-run box is answered. */
export function trackOnboard(step: Of<"onboard">["step"], engine?: string): void {
  if (step !== "welcome" && !firstRun) return;
  if (step === "welcome") {
    began = performance.now();
    firstRun = true;
    if (on === false) on = undefined;
    if (!first) saveFirst({ start: Date.now(), tries: 0 });
  }
  if (step === "finish" && first) saveFirst({ ...first, finish: Date.now() });
  track({ e: "onboard", step, ms: since(began), engine });
}

export function trackOpen(open: { label: string; firstContentfulPaint?: number; mount?: number; hello?: number; chatPaint?: number; cache?: { hit: boolean } }): void {
  track({ e: "open", label: open.label, fcpMs: whole(open.firstContentfulPaint), mountMs: whole(open.mount), helloMs: whole(open.hello), chatMs: whole(open.chatPaint), cached: open.cache?.hit });
}

export function trackUpdate(phase: Of<"update">["phase"], to?: string): void {
  track({ e: "update", phase, to });
}

/** Several components watch the updater; each change of status counts once. */
export function trackUpdater(status: string | undefined, to?: string): void {
  if (status === updater) return;
  updater = status;
  if (status === "available") trackUpdate("offered", to);
  else if (status === "error") trackUpdate("failed", to);
}

/** The live stream to the PC dropped or came back; 5 s or more down on a visible page is a stall. */
export function trackStream(open: boolean): void {
  if (!open) {
    if (!streamDown && on !== false && globalThis.document?.visibilityState === "visible") streamDown = performance.now();
    return;
  }
  if (streamDown && since(streamDown) >= 5000) track({ e: "stall", where: "stream", ms: since(streamDown) });
  streamDown = 0;
}

function trackError(site: "rendererError" | "rendererRejection", error: unknown): void {
  if (on === false) return;
  const trace = error instanceof Error ? error.stack : undefined;
  // The schema module is loaded on the first error, never at startup.
  void import("../../shared/usage-stats")
    .then(({ stackHash }) => track({ e: "error", site, code: "UNKNOWN_ERROR", stack: trace ? stackHash(trace)?.stack : undefined }))
    .catch(() => {});
}

function drop(): void {
  buffer = [];
  screens.clear();
  sending = undefined;
}

/** The switch as this PC's server reports it, at load and after a change made on this screen. */
export function usageStatsSwitched(capture: boolean, id?: unknown, answered = true): void {
  if (answered) {
    firstRun = false;
    switches++;
  }
  period = id;
  on = capture ? true : firstRun ? undefined : false;
  if (on === false) {
    drop();
    saveFirst(undefined);
  } else if (on && answered) flush();
}

async function learn(): Promise<void> {
  const started = switches;
  try {
    const response = await fetch(SWITCH_PATH);
    if (!response.ok) return;
    const body = await response.json() as { capture?: unknown; period?: unknown };
    // A switch made here while the PC was answering wins.
    if (started === switches) usageStatsSwitched(body.capture === true, body.period, false);
  } catch { /* Events wait until the PC answers. */ }
}

function flush(last = false): void {
  if (on === undefined && !last) void learn();
  if (on !== true) return;
  if (sending && (last || since(sending.start) > 2 * FLUSH_MS)) settleSend();
  const hour = Math.floor(Date.now() / HOUR);
  if (last || hour !== screenHour) {
    for (const [name, n] of screens) track({ e: "screen", name, n });
    screens.clear();
  }
  screenHour = hour;
  if (!buffer.length) return;
  const c = window.ogb ? "desktop" : isPhone() ? "phone" : "browser";
  const events = buffer.map((event) => (WITH_CLIENT.has(event.e) ? { ...event, c } : event));
  buffer = [];
  const ui = uiChanged ? readUi?.() : undefined;
  uiChanged = false;
  // Not api(): its reload hold would make an update wait on a stats post.
  fetch(PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events, ui, lang: document.documentElement.dataset.locale === "ko" ? "ko" : "en", period }),
    keepalive: true,
  }).then((response) => {
    if (response.status !== 409) return;
    // Off, or on again since this screen last asked: what it held is dropped either way.
    usageStatsSwitched(false);
    void learn();
  }).catch(() => {});
}

/** Costs one idle callback at startup; everything else waits for it. */
export function startUsageStats(ui: () => Row, phone: () => boolean, target: Window = window): void {
  readUi = ui;
  isPhone = phone;
  const idle = target.requestIdleCallback?.bind(target) ?? ((run: () => void) => target.setTimeout(run, 2000));
  idle(() => {
    screenHour = Math.floor(Date.now() / HOUR);
    loadFirst();
    void learn();
    target.setInterval(flush, FLUSH_MS);
    target.addEventListener("pagehide", () => flush(true));
    target.document.addEventListener("visibilitychange", () => {
      if (target.document.visibilityState === "hidden") {
        streamDown = 0;
        flush(true);
      } else if (on !== true) void learn();
    });
    target.addEventListener("error", (event) => { if (event.error) trackError("rendererError", event.error); });
    target.addEventListener("unhandledrejection", (event) => trackError("rendererRejection", event.reason));
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (entry.duration >= 1000) track({ e: "stall", where: "ui", ms: Math.round(entry.duration) });
      }).observe({ type: "longtask" });
    } catch { /* Safari has no long task entries. */ }
  });
}
