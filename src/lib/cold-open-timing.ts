import { trackOpen } from "./usage-stats";

// Where a phone page's open spends its time, from a notification tap or a plain launch.
export const COLD_OPEN_PATH = "/api/diag/cold-open";
export const COLD_OPEN_TIMEOUT_MS = 30_000;
export const COLD_OPEN_HEADER = "x-cold-open";
export const COLD_OPEN_QUERY = "coldOpen";
const USER_AGENT_MAX = 512;

export type ColdOpenLabel = "notification" | "open" | "warm" | "resume" | "terminal";
export type ColdOpenMark = "mount" | "sseOpen" | "hello";

const NAV_FIELDS = [
  "fetchStart",
  "connectStart",
  "connectEnd",
  "secureConnectionStart",
  "requestStart",
  "responseStart",
  "responseEnd",
  "domInteractive",
  "domContentLoadedEventEnd",
] as const;

type NavField = (typeof NAV_FIELDS)[number];

export interface ColdOpenRequest {
  start: number;
  end: number;
  transferSize: number;
  encodedBodySize: number;
}

export interface ColdOpenBots extends ColdOpenRequest {
  connectStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  decodedBodySize: number;
  nextHopProtocol: string;
}

export type ColdOpenSseEvent = "created" | "open" | "error";

export interface ColdOpenSse {
  created: number;
  open?: number;
  errors: number;
  lastError?: number;
}

/** A terminal opened on the page: marks count from page load, like the resource times in `read`. */
export interface ColdOpenTerminal {
  tap: number;
  fetchStart?: number;
  read?: ColdOpenBots;
  paint?: number;
  /** How long before the tap the page came back from hidden, when it did. */
  sinceResume?: number;
}

export interface ColdOpenRecord {
  desktop?: true;
  openId?: string;
  label: ColdOpenLabel;
  t0?: number;
  hiddenMs?: number;
  nav?: Partial<Record<NavField, number>>;
  firstPaint?: number;
  firstContentfulPaint?: number;
  mount?: number;
  sseOpen?: number;
  hello?: number;
  sse?: ColdOpenSse;
  bots?: ColdOpenBots;
  taskSwitch?: ColdOpenRequest;
  cache?: { hit: boolean; paint?: number };
  terminal?: ColdOpenTerminal;
  chatPaint?: number;
  jsCached?: boolean;
  cssCached?: boolean;
  navigationType?: string;
  displayMode: "standalone" | "browser";
  visibility: string;
  build?: string;
  userAgent: string;
}

type Navigation = Pick<PerformanceNavigationTiming, NavField | "type">;
type Paint = Pick<PerformanceEntry, "name" | "startTime">;
type Resource = Pick<
  PerformanceResourceTiming,
  "name" | "startTime" | "responseEnd" | "transferSize" | "encodedBodySize" | "connectStart" | "connectEnd" | "requestStart" | "responseStart" | "decodedBodySize" | "nextHopProtocol"
>;

export interface ColdOpenPage {
  desktop?: boolean;
  href: string;
  timeOrigin: number;
  now: () => number;
  clock: () => number;
  navigation: () => Navigation | undefined;
  paints: () => readonly Paint[];
  resources: () => readonly Resource[];
  replaceUrl: (url: string) => void;
  standalone: () => boolean;
  visibility: () => string;
  build: () => string | undefined;
  userAgent: string;
  randomId: () => string;
  afterPaint: (done: () => void) => void;
  send: (body: string) => void;
}

interface Pending {
  label: ColdOpenLabel;
  t0?: number;
  /** Marks count from here: page load, or the moment a resumed page came back. */
  since: number;
  hiddenMs?: number;
  threadId?: string;
  visibility: string;
  /** Ties the server's timings for this page's first bots and stream requests to the record. */
  id?: string;
  botsSent: boolean;
  sse: { created?: number; open?: number; errors: number; lastError?: number };
  cache?: { hit: boolean; paint?: number };
  cachePainting: boolean;
  marks: Partial<Record<ColdOpenMark, number>>;
  painting: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const BOTS = /\/api\/bots\?messages=/;
const TERMINAL_READ = /\/api\/bots\/[^/]+\/terminal$/;
const TASK_SWITCH = /\/api\/(?:bots|groups)\/[^/]+\/tasks\/[^/?]+$/;
const ENTRY_JS = /\/assets\/index-[\w-]+\.js$/;
const ENTRY_CSS = /\/assets\/index-[\w-]+\.css$/;

/** The address without the notification's click time, or null when it has none. */
export function withoutClickTime(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("t0")) return null;
  url.searchParams.delete("t0");
  return url.pathname + url.search + url.hash;
}

function clickTime(at: number): number | undefined {
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

function request(entry: Resource | undefined, since = 0): ColdOpenRequest | undefined {
  if (!entry) return undefined;
  return {
    start: Math.round(entry.startTime - since),
    end: Math.round(entry.responseEnd - since),
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
  };
}

/** Times count from `since`; a field the browser hides stays 0. */
function botsRequest(entry: Resource | undefined, since = 0): ColdOpenBots | undefined {
  const base = request(entry, since);
  if (!entry || !base) return undefined;
  const at = (ms: number) => (ms ? Math.round(ms - since) : 0);
  return {
    ...base,
    connectStart: at(entry.connectStart),
    connectEnd: at(entry.connectEnd),
    requestStart: at(entry.requestStart),
    responseStart: at(entry.responseStart),
    decodedBodySize: entry.decodedBodySize,
    nextHopProtocol: entry.nextHopProtocol,
  };
}

function cached(entry: Resource | undefined): boolean | undefined {
  return entry ? entry.transferSize === 0 : undefined;
}

interface TerminalOpen {
  tap: number;
  /** The worker's session id the tap asked for, null for Main, undefined when it named none. */
  pane?: string | null;
  sinceResume?: number;
  hiddenMs?: number;
  fetchStart?: number;
  painting: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export function createColdOpenTiming(page: ColdOpenPage) {
  let pending: Pending | null = null;
  let terminal: TerminalOpen | null = null;
  let hiddenAt: number | undefined;
  let resumed: { at: number; hiddenMs: number } | undefined;
  const navigation = page.navigation();

  const begin = (label: ColdOpenLabel, t0: number | undefined, threadId: string | undefined, resumed?: { since: number; hiddenMs: number }) => {
    const timer = setTimeout(() => finish(), COLD_OPEN_TIMEOUT_MS);
    const id = label === "warm" ? undefined : page.randomId();
    pending = { label, t0, since: resumed?.since ?? 0, hiddenMs: resumed?.hiddenMs, threadId, visibility: page.visibility(), id, botsSent: false, sse: { errors: 0 }, cachePainting: false, marks: {}, painting: false, timer };
  };

  const metaFor = (visibility: string) => ({
    ...(page.desktop ? { desktop: true as const } : {}),
    displayMode: page.standalone() ? ("standalone" as const) : ("browser" as const),
    visibility,
    build: page.build(),
    userAgent: page.userAgent.slice(0, USER_AGENT_MAX),
  });

  const record = (open: Pending, chatPaint: number | undefined): ColdOpenRecord => {
    const meta = metaFor(open.visibility);
    const t0 = open.t0 === undefined ? undefined : Math.round(open.t0 - page.timeOrigin);
    if (open.label === "warm") return { label: "warm", t0, chatPaint, ...meta };
    const { created, ...sse } = open.sse;
    const link = created === undefined ? undefined : { created, ...sse };
    if (open.label === "resume") {
      const bots = page.resources().find((entry) => BOTS.test(entry.name) && entry.startTime >= open.since);
      return { openId: open.id, label: "resume", hiddenMs: open.hiddenMs, ...open.marks, sse: link, bots: botsRequest(bots, open.since), chatPaint, ...meta };
    }
    const paint = (name: string) => {
      const at = page.paints().find((entry) => entry.name === name)?.startTime;
      return at === undefined ? undefined : Math.round(at);
    };
    const resources = page.resources();
    const path = (entry: Resource) => new URL(entry.name, page.href).pathname;
    const nav = navigation
      ? Object.fromEntries(NAV_FIELDS.flatMap((field) => (Number.isFinite(navigation[field]) ? [[field, Math.round(navigation[field])] as const] : [])))
      : undefined;
    return {
      openId: open.id,
      label: open.label,
      t0,
      nav,
      firstPaint: paint("first-paint"),
      firstContentfulPaint: paint("first-contentful-paint"),
      ...open.marks,
      sse: link,
      bots: botsRequest(resources.find((entry) => BOTS.test(entry.name))),
      taskSwitch: request(resources.find((entry) => TASK_SWITCH.test(path(entry)))),
      cache: open.cache,
      chatPaint,
      jsCached: cached(resources.find((entry) => ENTRY_JS.test(path(entry)))),
      cssCached: cached(resources.find((entry) => ENTRY_CSS.test(path(entry)))),
      navigationType: navigation?.type,
      ...meta,
    };
  };

  const finish = (chatPaint?: number) => {
    const open = pending;
    if (!open) return;
    pending = null;
    clearTimeout(open.timer);
    try {
      const sent = record(open, chatPaint);
      page.send(JSON.stringify(sent));
      trackOpen(sent);
    } catch {
      // Timing is best effort; it never surfaces.
    }
  };

  /** `target` is the session id the read asked for, undefined for the default pane, which is `main` once the roster names it. */
  const terminalWants = (open: TerminalOpen, target: string | undefined, main: string | undefined) =>
    open.pane === undefined || (open.pane === null ? target === undefined : (target ?? main) === open.pane);

  const finishTerminal = (paint?: number) => {
    const open = terminal;
    if (!open) return;
    terminal = null;
    clearTimeout(open.timer);
    try {
      const { fetchStart } = open;
      const read = fetchStart === undefined ? undefined : page.resources().find((entry) => entry.startTime >= fetchStart - 1 && readsPane(entry.name, open.pane));
      const sent: ColdOpenRecord = {
        label: "terminal",
        hiddenMs: open.hiddenMs,
        terminal: { tap: open.tap, fetchStart, read: botsRequest(read), paint, sinceResume: open.sinceResume },
        ...metaFor(page.visibility()),
      };
      page.send(JSON.stringify(sent));
    } catch {
      // Timing is best effort; it never surfaces.
    }
  };

  const readsPane = (name: string, pane: string | null | undefined) => {
    const url = new URL(name, page.href);
    return TERMINAL_READ.test(url.pathname) && (pane === undefined || url.searchParams.get("sessionId") === pane);
  };

  const search = new URL(page.href).searchParams;
  const t0 = clickTime(Number(search.get("t0")));
  const stripped = withoutClickTime(page.href);
  if (stripped !== null) page.replaceUrl(stripped);
  const thread = search.get("thread") ?? undefined;
  if (t0 !== undefined) begin("notification", t0, thread);
  else if (navigation?.type === "navigate") begin("open", undefined, search.get("bot") ? thread : undefined);

  return {
    mark(name: ColdOpenMark) {
      if (!pending || pending.label === "warm" || pending.marks[name] !== undefined) return;
      pending.marks[name] = Math.round(page.now() - pending.since);
    },
    /** A resumed page's chat has caught up with the server. */
    resumeCurrent() {
      const open = pending;
      if (open?.label !== "resume" || open.painting) return;
      open.painting = true;
      page.afterPaint(() => {
        if (pending === open) finish(Math.round(page.now() - open.since));
      });
    },
    visibility(hidden: boolean) {
      if (page.desktop) return;
      if (hidden) {
        hiddenAt = page.clock();
        return;
      }
      if (hiddenAt === undefined) return;
      const hiddenMs = Math.round(page.clock() - hiddenAt);
      hiddenAt = undefined;
      resumed = { at: page.now(), hiddenMs };
      // A first open still measuring keeps its own record.
      if (!pending) begin("resume", undefined, undefined, { since: page.now(), hiddenMs });
    },
    /** The id for the first stream address and the first bots request of this page, once each. */
    streamId() {
      return pending?.sse.created === undefined ? pending?.id : undefined;
    },
    botsHeader(): Record<string, string> {
      if (!pending?.id || pending.botsSent) return {};
      pending.botsSent = true;
      return { [COLD_OPEN_HEADER]: pending.id };
    },
    sse(event: ColdOpenSseEvent) {
      // Only the first connection's road to its first open is measured.
      if (!pending?.id || pending.sse.open !== undefined) return;
      const sse = pending.sse;
      const at = Math.round(page.now() - pending.since);
      if (event === "created") sse.created ??= at;
      else if (event === "open") sse.open = at;
      else {
        sse.errors += 1;
        sse.lastError = at;
      }
    },
    cacheLoaded(hit: boolean) {
      if (pending && pending.label !== "warm") pending.cache ??= { hit };
    },
    /** The thread whose saved messages are on screen before the live ones arrive. */
    cacheShown(threadId: string | undefined) {
      const open = pending;
      if (!open?.cache?.hit || open.cache.paint !== undefined || open.cachePainting || !threadId) return;
      if (open.threadId && open.threadId !== threadId) return;
      open.cachePainting = true;
      page.afterPaint(() => {
        if (pending === open) open.cache!.paint = Math.round(page.now());
      });
    },
    /** The thread whose fresh messages are on screen, if any. */
    chatShown(threadId: string | undefined) {
      // A resumed page shows its chat all along; resumeCurrent says when it is fresh.
      if (!pending || pending.label === "resume" || pending.painting || !threadId) return;
      if (pending.threadId && pending.threadId !== threadId) return;
      pending.painting = true;
      const open = pending;
      page.afterPaint(() => {
        if (pending === open) finish(Math.round(page.now()));
      });
    },
    /** The tap that opens the terminal; `pane` is the worker it asked for, null for Main. */
    terminalOpened(pane?: string | null) {
      finishTerminal();
      const tap = page.now();
      terminal = {
        tap: Math.round(tap),
        pane,
        sinceResume: resumed && Math.round(tap - resumed.at),
        hiddenMs: resumed?.hiddenMs,
        painting: false,
        timer: setTimeout(() => finishTerminal(), COLD_OPEN_TIMEOUT_MS),
      };
    },
    /** The terminal view is about to read `target` (undefined for Main); only the first read of the opened pane counts. */
    terminalFetching(target?: string, main?: string) {
      if (terminal && terminalWants(terminal, target, main)) terminal.fetchStart ??= Math.round(page.now());
    },
    /** The terminal view applied a read of `target`. */
    terminalShown(target?: string, main?: string) {
      const open = terminal;
      if (!open || open.painting || open.fetchStart === undefined || !terminalWants(open, target, main)) return;
      open.painting = true;
      page.afterPaint(() => {
        if (terminal === open) finishTerminal(Math.round(page.now()));
      });
    },
    warm(t0: number, threadId: string) {
      const at = clickTime(t0);
      if (at === undefined) return;
      // A newer tap drops the unfinished measurement: its end would no longer be what it started from.
      if (pending) clearTimeout(pending.timer);
      begin("warm", at, threadId);
    },
  };
}

type ColdOpenTiming = ReturnType<typeof createColdOpenTiming>;

let active: ColdOpenTiming | null = null;

function browserPage(): ColdOpenPage {
  return {
    desktop: Boolean(window.ogb),
    href: window.location.href,
    timeOrigin: performance.timeOrigin,
    now: () => performance.now(),
    clock: () => Date.now(),
    navigation: () => performance.getEntriesByType("navigation").find((entry) => entry instanceof PerformanceNavigationTiming),
    paints: () => performance.getEntriesByType("paint"),
    resources: () => performance.getEntriesByType("resource").filter((entry) => entry instanceof PerformanceResourceTiming),
    replaceUrl: (url) => window.history.replaceState(window.history.state, "", url),
    standalone: () => window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    visibility: () => document.visibilityState,
    build: () =>
      document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute("src")?.split("/").pop(),
    userAgent: navigator.userAgent,
    // getRandomValues works on plain-http origins; randomUUID does not.
    randomId: () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    afterPaint: (done) => requestAnimationFrame(() => setTimeout(done, 0)),
    send: (body) => {
      void fetch(COLD_OPEN_PATH, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    },
  };
}

export function startColdOpenTiming() {
  if (active) return;
  const timing = createColdOpenTiming(browserPage());
  active = timing;
  document.addEventListener("visibilitychange", () => timing.visibility(document.visibilityState === "hidden"));
}

export function markColdOpen(name: ColdOpenMark) {
  active?.mark(name);
}

export function noteChatShown(threadId: string | undefined) {
  active?.chatShown(threadId);
}

export function noteResumeCurrent() {
  active?.resumeCurrent();
}

export function noteCacheLoaded(hit: boolean) {
  active?.cacheLoaded(hit);
}

export function noteCacheShown(threadId: string | undefined) {
  active?.cacheShown(threadId);
}

export function noteSse(event: ColdOpenSseEvent) {
  active?.sse(event);
}

/** Query value for the page's first stream address; undefined for every later one. */
export function firstStreamId() {
  return active?.streamId();
}

/** Header for the page's first bots request; empty for every later one. */
export function firstBotsHeader() {
  return active?.botsHeader() ?? {};
}

export function noteTerminalOpened(pane?: string | null) {
  active?.terminalOpened(pane);
}

export function noteTerminalFetching(target?: string, main?: string) {
  active?.terminalFetching(target, main);
}

export function noteTerminalShown(target?: string, main?: string) {
  active?.terminalShown(target, main);
}

export function startWarmOpenTiming(t0: number, threadId: string) {
  active?.warm(t0, threadId);
}
