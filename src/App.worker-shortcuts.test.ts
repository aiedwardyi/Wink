// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import App from "./App";
import { lastViewedPanes } from "./components/TerminalWorkspace";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

// oxlint-disable-next-line anti-slop/no-module-mocking -- The DOM harness has no canvas.
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = {};
  cols = 80;
  rows = 24;
  loadAddon() {}
  open() {}
  focus() {}
  dispose() {}
  refresh() {}
  resize() {}
  write(_data: string, done?: () => void) { done?.(); }
  onData() { return { dispose() {} }; }
  onBinary() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
} }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Sizing needs a browser.
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Link detection needs a browser.
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { dispose() {} } }));

const mount = async (desktop = true, alert = "STALLED: no screen change for 2 min and no report.", changedAt = 41_000, phone = false) => {
  const panes = [1, 2].map((n) => ({ sessionId: `${n === 1 ? "aaaaaaaa" : "bbbbbbbb"}-pane`, label: `WORK-${n}`, main: false, changedAt }));
  const messages = [
    ...panes.map((pane, index) => ({ id: `l${index}`, at: (index + 1) * 1_000, role: "bot", kind: "launch", text: `Launched ${pane.label}\nLabel: ${pane.label}\nSession: ${pane.sessionId}` })),
    { id: "n1", at: 10_000, role: "bot", kind: "note", text: `[pane bbbbbbbb] [WORK-2] from Wink (b1): ${alert}` },
  ];
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: ["Scout", "Map"].map((name, index) => ({ id: `b${index + 1}`, threadId: `t${index + 1}`, name, messages: index === 0 ? messages : [], modelSelection: { instanceId: "inst", model: "m" } })),
    groups: [], selectedId: "b1",
  }));
  const readBot = vi.fn(async () => ({ panes }));
  const open = vi.fn(async (input: { sessionId?: string }) => ({ id: input.sessionId ?? "main", cwd: "C:\\work", shell: "pwsh.exe", output: "", seq: 0, exitCode: null }));
  if (desktop) Object.defineProperty(window, "ogb", { configurable: true, value: { platform: "win32", terminal: {
    readBot, open, write: vi.fn(), resize: vi.fn(async () => {}), onData: () => () => {}, onExit: () => () => {},
  } } });
  const roster = vi.fn(async (path: string) => new Response(JSON.stringify({ sessionId: new URL(path, "http://localhost").searchParams.get("sessionId") ?? "main", generation: 1, screenText: "ready", panes })));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (phone) vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("max-width"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true),
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn((input: string) => String(input).includes("/terminal") && !String(input).includes("pane-counts") ? roster(String(input)) : new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  const terminal = () => host.querySelector<HTMLElement>('.orbit-terminal-overlay[data-open="true"]');
  return {
    host, panes, readBot, roster, terminal,
    press: async (code: string, init: KeyboardEventInit = {}) => act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init }));
    }),
    list: async () => {
      await act(async () => terminal()!.querySelector<HTMLButtonElement>("header [data-worker-strip]")!.click());
      return [...document.querySelectorAll<HTMLButtonElement>("[data-worker-list] li button")];
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
      delete window.ogb;
      lastViewedPanes.clear();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
    },
  };
};

it.each(["STALLED: no screen change for 2 min and no report.", "WAITING: this worker is stuck on an on-screen prompt (permission check)."])("matches desktop menu hints to Alt+number after output resumes past %s", async (alert) => {
  const f = await mount(true, alert);
  try {
    await f.press("Backquote", { ctrlKey: true });
    await vi.waitFor(() => expect(f.terminal()?.querySelector("header [data-worker-strip]")).toBeTruthy());
    const rows = await f.list();
    expect(rows.map((row) => row.title)).toEqual(["WORK-1 (Alt+1)", "WORK-2 (Alt+2)"]);
    await act(async () => f.terminal()!.querySelector<HTMLButtonElement>("header [data-worker-strip]")!.click());
    for (const [index, row] of rows.entries()) {
      await f.press(`Digit${index + 1}`, { altKey: true });
      await vi.waitFor(() => expect(f.terminal()?.querySelector("header h1")?.textContent).toContain(row.title.split(" (")[0]));
    }
  } finally { await f.unmount(); }
});

it.each([true, false])("keeps a delayed worker lookup from reopening a closed terminal with desktop=%s", async (desktop) => {
  const f = await mount(desktop);
  try {
    let resolve!: () => void;
    if (desktop) f.readBot.mockImplementationOnce(() => new Promise((done) => { resolve = () => done({ panes: f.panes }); }));
    else f.roster.mockImplementationOnce(() => new Promise((done) => { resolve = () => done(new Response(JSON.stringify({ panes: f.panes }))); }));
    await f.press("Digit2", { altKey: true });
    await f.press("Backquote", { ctrlKey: true });
    await vi.waitFor(() => expect(f.terminal()?.querySelector("header [data-worker-strip]")).toBeTruthy());
    await f.press("Backquote", { ctrlKey: true });
    expect(f.terminal()).toBeNull();
    await act(async () => resolve());
    expect(f.terminal()).toBeNull();
  } finally { await f.unmount(); }
});

it.each([[true, false], [false, false], [false, true]])("matches the mounted menu when a worker resumes after mount with desktop=%s phone=%s", async (desktop, phone) => {
  const f = await mount(desktop, "STALLED: no screen change for 2 min and no report.", 10_000, phone);
  try {
    await f.press("Backquote", { ctrlKey: true });
    await vi.waitFor(() => expect(f.terminal()?.querySelector("header [data-worker-strip]")).toBeTruthy());
    const rows = await f.list();
    expect(rows.map((row) => row.querySelector("span.truncate.font-medium")?.textContent)).toEqual(["WORK-2", "WORK-1"]);
    if (!phone) expect(rows.map((row) => row.title)).toEqual(["WORK-2 (Alt+1)", "WORK-1 (Alt+2)"]);
    await act(async () => {
      f.panes[1].changedAt = 41_000;
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", altKey: true, bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(f.terminal()?.querySelector("header h1")?.textContent).toContain("WORK-2"));
  } finally { await f.unmount(); }
});

it("keeps the remembered worker after opening Main and switching away and back", async () => {
  const f = await mount();
  try {
    await act(async () => f.host.querySelector<HTMLButtonElement>("[data-worker-strip]")!.click());
    await act(async () => f.host.querySelector<HTMLButtonElement>("[data-worker-terminal]")!.click());
    await vi.waitFor(() => expect(f.terminal()?.querySelector("header [data-worker-strip]")).toBeTruthy());
    const rows = await f.list();
    await act(async () => rows.find((row) => row.title.startsWith("WORK-2 "))!.click());
    expect(f.terminal()?.querySelector("header h1")?.textContent).toContain("WORK-2");
    await f.press("Digit2", { ctrlKey: true });
    await f.press("Digit1", { ctrlKey: true });
    await vi.waitFor(() => expect(f.terminal()?.querySelector("header [data-worker-strip]")).toBeTruthy());
    expect(f.terminal()?.querySelector("header h1")?.textContent).toContain("WORK-2");
  } finally { await f.unmount(); }
});
