// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebTerminalBridge, useWebTerminalBridge, webTerminalFonts, type LiveOutput, type WebTerminalBridge } from "./web-terminal-bridge";

type Frame = Partial<{ kind: string; lease: string; sessionId: string; generation: number; output: string; data: string; seq: number; cols: number; rows: number; exitCode: number | null; modes: number[]; resetModes: number[] }>;
type Live = { url: string; aborted: boolean; push: (frame: Frame) => void; end: () => void };
type Post = { path: string; body: Frame };
type Pane = { sessionId: string; label: string | null; generation: number; main: boolean };

const encoder = new TextEncoder();
let lives: Live[];
let posts: Post[];
let liveRefusals: Response[];
let liveDrops: number;
let roster: Pane[];
let rosterDown: boolean;
let failResizes: number;
let held: Array<() => void>;
let holdPosts: boolean;
let visibility: DocumentVisibilityState;
let bridges: WebTerminalBridge[] = [];
const make = () => {
  const bridge = createWebTerminalBridge("bot-1");
  bridges.push(bridge);
  return bridge;
};

const snapshot = (over: Frame = {}) => ({ kind: "snapshot", lease: "lease-1", sessionId: "s1", generation: 1, output: "prompt> ", seq: 5, cols: 100, rows: 30, exitCode: null, ...over });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((done) => setTimeout(done, 0)); };
const inputs = () => posts.filter((post) => post.path.endsWith("/input")).map((post) => post.body.data);

beforeEach(() => {
  lives = [];
  posts = [];
  liveRefusals = [];
  liveDrops = 0;
  roster = [];
  rosterDown = false;
  failResizes = 0;
  held = [];
  holdPosts = false;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method && !url.includes("/terminal/live")) return rosterDown ? Response.json({ error: "Bridge offline" }, { status: 502 }) : Response.json({ panes: roster });
    if (url.includes("/terminal/live")) {
      if (liveDrops > 0 && liveDrops--) throw new TypeError("Failed to fetch");
      const refused = liveRefusals.shift();
      if (refused) return refused;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const live: Live = {
        url,
        aborted: false,
        push: (frame) => controller.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify(frame)}\n\n`)),
        end: () => controller.close(),
      };
      init?.signal?.addEventListener("abort", () => {
        live.aborted = true;
        try { controller.error(new DOMException("aborted", "AbortError")); } catch {}
      });
      lives.push(live);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    posts.push({ path: url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (url.endsWith("/resize") && failResizes > 0 && failResizes--) return Response.json({ error: "Bridge offline" }, { status: 502 });
    if (holdPosts && url.endsWith("/input")) await new Promise<void>((done) => held.push(done));
    return Response.json(url.endsWith("/start") ? { sessionId: "s1", generation: 1 } : { ok: true });
  }));
});

afterEach(async () => {
  await Promise.all(bridges.map((bridge) => bridge.cancelOpen?.("bot-1")));
  bridges = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function attach(bridge: WebTerminalBridge, over: Frame = {}) {
  const opened = bridge.open({ botId: "bot-1", cols: 80, rows: 24 });
  opened.catch(() => {});
  await flush();
  expect(lives.length, "live stream opened").toBeGreaterThan(0);
  lives.at(-1)!.push(snapshot(over));
  return opened;
}

describe("createWebTerminalBridge", () => {
  it("opens on the live snapshot and streams output, size and exit in seq order", async () => {
    const bridge = make();
    const seen: LiveOutput[] = [];
    const exits: number[] = [];
    bridge.onData((event) => seen.push(event));
    bridge.onExit((event) => exits.push(event.exitCode));
    const opened = await attach(bridge, { modes: [2004], resetModes: [25] });
    expect(lives[0].url).toBe("/api/bots/bot-1/terminal/live");
    expect(opened).toMatchObject({ id: "s1", output: "prompt> ", seq: 5, cols: 100, rows: 30, exitCode: null, modes: [2004], resetModes: [25] });
    lives[0].push({ kind: "output", seq: 5, data: "old" });
    lives[0].push({ kind: "output", seq: 6, data: "a" });
    lives[0].push({ kind: "ping" });
    lives[0].push({ kind: "output", seq: 7, data: "b" });
    lives[0].push({ kind: "exit", exitCode: 0 });
    await flush();
    expect(seen.map((event) => [event.id, event.data, event.seq])).toEqual([["s1", "a", 6], ["s1", "b", 7]]);
    expect(exits).toEqual([0]);
  });

  it("starts the bot's main shell when none is running, then attaches", async () => {
    liveRefusals.push(Response.json({ error: "No active terminal for this bot" }, { status: 409 }));
    const bridge = make();
    const opened = bridge.open({ botId: "bot-1", cols: 80, rows: 24 });
    opened.catch(() => {});
    await flush();
    expect(posts.map((post) => post.path)).toEqual(["/api/bots/bot-1/terminal/start"]);
    lives[0].push(snapshot());
    await expect(opened).resolves.toMatchObject({ id: "s1" });
  });

  it("starts the main shell before attaching when only worker panes run", async () => {
    roster = [{ sessionId: "w1", label: "worker", generation: 1, main: false }];
    const bridge = make();
    const opened = bridge.open({ botId: "bot-1", cols: 80, rows: 24 });
    opened.catch(() => {});
    await flush();
    expect(posts.map((post) => post.path)).toEqual(["/api/bots/bot-1/terminal/start"]);
    expect(lives.map((live) => live.url)).toEqual(["/api/bots/bot-1/terminal/live"]);
    lives[0].push(snapshot());
    await expect(opened).resolves.toMatchObject({ id: "s1" });
  });

  it("attaches a picked pane by its session and surfaces other refusals", async () => {
    liveRefusals.push(Response.json({ error: "Unknown terminal" }, { status: 404 }));
    const bridge = make();
    await expect(bridge.open({ botId: "bot-1", cols: 80, rows: 24, sessionId: "pane-2" })).rejects.toThrow("Unknown terminal");
    expect(posts).toEqual([]);
    const opened = bridge.open({ botId: "bot-1", cols: 80, rows: 24, sessionId: "pane-2" });
    await flush();
    expect(lives[0].url).toBe("/api/bots/bot-1/terminal/live?sessionId=pane-2");
    lives[0].push(snapshot({ sessionId: "pane-2" }));
    await expect(opened).resolves.toMatchObject({ id: "pane-2" });
  });

  it("keeps one input POST in flight and sends keys typed meanwhile together, in order", async () => {
    const bridge = make();
    await attach(bridge);
    holdPosts = true;
    const first = bridge.write("s1", "\x1b[B");
    const rest = [bridge.write("s1", "\r"), bridge.write("s1", "\x1b"), bridge.write("s1", "\x03")];
    await flush();
    expect(inputs()).toEqual(["\x1b[B"]);
    held.shift()!();
    await first;
    await flush();
    expect(inputs()).toEqual(["\x1b[B", "\r\x1b\x03"]);
    held.shift()!();
    await Promise.all(rest);
    expect(posts.at(-1)!.body).toEqual({ sessionId: "s1", generation: 1, data: "\r\x1b\x03" });
  });

  it("splits a large paste under the server cap without breaking a character, in order", async () => {
    const bridge = make();
    await attach(bridge);
    const korean = "\uAC00".repeat(30_000);
    const emoji = `a${"\u{1F600}".repeat(9_000)}`;
    await Promise.all([bridge.write("s1", korean), bridge.write("s1", emoji)]);
    const sent = inputs().map((data) => data ?? "");
    expect(sent.join("")).toBe(korean + emoji);
    expect(sent.every((data) => new TextEncoder().encode(data).length <= 64 * 1024)).toBe(true);
    expect(sent.some((data) => /[\uD800-\uDBFF]$/.test(data))).toBe(false);
  });

  it("retries a size the shell did not take", async () => {
    const bridge = make();
    await attach(bridge);
    await bridge.resize("s1", 120, 40);
    failResizes = 1;
    await bridge.write("s1", "x");
    await bridge.write("s1", "y");
    await flush();
    expect(posts.map((post) => post.path.split("/").at(-1))).toEqual(["resize", "input", "resize", "input"]);
    expect(inputs()).toEqual(["x", "y"]);
  });

  it("keeps the size while its own late echoes arrive during a drag", async () => {
    const bridge = make();
    await attach(bridge);
    await bridge.resize("s1", 110, 30);
    await bridge.write("s1", "x");
    await bridge.resize("s1", 111, 30);
    await flush();
    lives[0].push({ kind: "resize", cols: 110, rows: 30 });
    await flush();
    await bridge.resize("s1", 112, 30);
    await flush();
    expect(posts.filter((post) => post.path.endsWith("/resize")).map((post) => post.body.cols)).toEqual([110, 111, 112]);
  });

  it("resizes the shell only once the browser types, size first", async () => {
    const bridge = make();
    await attach(bridge);
    await bridge.resize("s1", 120, 40);
    await flush();
    expect(posts).toEqual([]);
    await bridge.write("s1", "x");
    await flush();
    expect(posts.map((post) => [post.path.split("/").at(-1), post.body])).toEqual([
      ["resize", { sessionId: "s1", generation: 1, cols: 120, rows: 40 }],
      ["input", { sessionId: "s1", generation: 1, data: "x" }],
    ]);
    lives[0].push({ kind: "resize", cols: 120, rows: 40 });
    await flush();
    await bridge.resize("s1", 121, 40);
    await flush();
    expect(posts.at(-1)!.body).toMatchObject({ cols: 121, rows: 40 });
    lives[0].push({ kind: "resize", cols: 90, rows: 20 });
    await flush();
    await bridge.resize("s1", 122, 40);
    await flush();
    expect(posts.at(-1)!.body).toMatchObject({ cols: 121 });
  });

  it("pauses past 100 KB unparsed and resumes under 10 KB, replaying only missed output", async () => {
    const bridge = make();
    const seen: LiveOutput[] = [];
    bridge.onData((event) => seen.push(event));
    await attach(bridge);
    const chunk = "x".repeat(60 * 1024);
    lives[0].push({ kind: "output", seq: 6, data: chunk });
    lives[0].push({ kind: "output", seq: 7, data: chunk });
    await flush();
    expect(lives[0].aborted).toBe(true);
    seen[0].done?.();
    await flush();
    expect(lives).toHaveLength(1);
    seen[1].done?.();
    seen[1].done?.();
    await flush();
    expect(lives).toHaveLength(2);
    expect(lives[1].url).toBe("/api/bots/bot-1/terminal/live?sessionId=s1");
    lives[1].push(snapshot({ seq: 9, output: "fresh", modes: [1], resetModes: [2004] }));
    await flush();
    expect(seen.at(-1)).toMatchObject({ data: "\x1bcfresh\x1b[?2004l\x1b[?1h", seq: 9 });
  });

  it("closes the stream on a hidden tab and reopens on show without a replay when nothing was missed", async () => {
    const bridge = make();
    const seen: LiveOutput[] = [];
    bridge.onData((event) => seen.push(event));
    await attach(bridge);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(lives[0].aborted).toBe(true);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(lives).toHaveLength(2);
    lives[1].push(snapshot());
    lives[1].push({ kind: "output", seq: 6, data: "after" });
    await flush();
    expect(seen.map((event) => event.data)).toEqual(["after"]);
    window.dispatchEvent(new Event("pagehide"));
    expect(lives[1].aborted).toBe(true);
  });

  it("closes the stream while the pane is hidden and stops on cancel", async () => {
    const bridge = make();
    await attach(bridge);
    bridge.setVisible(false);
    expect(lives[0].aborted).toBe(true);
    bridge.setVisible(true);
    await flush();
    expect(lives).toHaveLength(2);
    lives[1].push(snapshot());
    await flush();
    await bridge.cancelOpen?.("bot-1");
    expect(lives[1].aborted).toBe(true);
    await expect(bridge.write("s1", "x")).rejects.toThrow();
  });

  it("keeps retrying a dropped stream while the network is down, without an error", async () => {
    const bridge = make();
    const errors: string[] = [];
    const seen: LiveOutput[] = [];
    bridge.onError?.((event) => errors.push(event.message));
    bridge.onData((event) => seen.push(event));
    await attach(bridge);
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    liveDrops = 2;
    lives[0].end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toEqual([]);
    expect(lives).toHaveLength(2);
    lives[1].push(snapshot({ seq: 6, output: "back" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toMatchObject({ data: "cback", seq: 6 });
  });

  it("retries with backoff when a reattached stream ends before its snapshot", async () => {
    const bridge = make();
    const errors: string[] = [];
    bridge.onError?.((event) => errors.push(event.message));
    await attach(bridge);
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    lives[0].end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lives).toHaveLength(2);
    lives[1].end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lives).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lives).toHaveLength(3);
    expect(errors).toEqual([]);
  });

  it("keeps worker panes when a roster check fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    roster = [{ sessionId: "w1", label: "worker", generation: 1, main: false }];
    const bridge = make();
    const closed: string[] = [];
    bridge.onClosed?.((event) => closed.push(event.id));
    await bridge.readBot?.("bot-1");
    roster = [{ sessionId: "w1", label: "worker", generation: 1, main: false }, { sessionId: "m1", label: null, generation: 1, main: true }];
    await attach(bridge);
    await flush();
    rosterDown = true;
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(closed).toEqual([]);
  });

  it("picks up worker panes that open or close while the pane shows", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const bridge = make();
    const events: string[] = [];
    bridge.onOpened?.((event) => events.push(`open ${event.id}`));
    bridge.onClosed?.((event) => events.push(`close ${event.id}`));
    await bridge.readBot?.("bot-1");
    await attach(bridge);
    await flush();
    roster = [{ sessionId: "w1", label: "worker", generation: 1, main: false }];
    vi.advanceTimersByTime(2_000);
    await flush();
    roster = [];
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(events).toEqual(["open w1", "close w1"]);
  });

  it("renews the lease every 50 s while streaming", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const bridge = make();
    await attach(bridge);
    await flush();
    vi.advanceTimersByTime(49_000);
    expect(posts).toEqual([]);
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(posts).toEqual([{ path: "/api/bots/bot-1/terminal/lease", body: { lease: "lease-1" } }]);
  });

  it("adds the bundled fonts ahead of the generic fallback", () => {
    expect(webTerminalFonts('"Cascadia Mono", Consolas, monospace')).toBe('"Cascadia Mono", Consolas, "JetBrains Mono", "Symbols Nerd Font Mono", monospace');
  });
});

describe("useWebTerminalBridge", () => {
  let root: Root;
  let host: HTMLDivElement;
  let pointer: string;
  const seen: Array<WebTerminalBridge | null> = [];
  function Probe({ live }: { live: boolean }) {
    seen.push(useWebTerminalBridge("bot-1", live, false));
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    seen.length = 0;
    pointer = "fine";
    vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const list: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener"> = { matches: pointer === "fine" && query.includes("pointer: fine"), addEventListener: vi.fn(), removeEventListener: vi.fn() };
      // SAFETY: the hook reads only matches and the change listener pair.
      return list as MediaQueryList;
    });
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.ogb;
    vi.restoreAllMocks();
  });

  it("gives desktop browsers a bridge only when the server has live routes", async () => {
    await act(async () => root.render(createElement(Probe, { live: false })));
    expect(seen.at(-1)).toBeNull();
    await act(async () => root.render(createElement(Probe, { live: true })));
    expect(seen.at(-1)).not.toBeNull();
  });

  it("leaves phones and the app on their own terminals", async () => {
    pointer = "coarse";
    await act(async () => root.render(createElement(Probe, { live: true })));
    expect(seen.at(-1)).toBeNull();
    await act(async () => root.unmount());
    pointer = "fine";
    Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32" } });
    root = createRoot(host);
    await act(async () => root.render(createElement(Probe, { live: true })));
    expect(seen.at(-1)).toBeNull();
  });
});
