// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOTION_MODERATE_MS } from "@/lib/motion";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

vi.mock("../shared/live-verify", async importOriginal => ({ ...await importOriginal<typeof import("../shared/live-verify")>(), LIVE_VERIFY_V0: true }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}), destroy() {} }) }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.min.mjs" }));

let App: typeof import("./App").default;
let pane: typeof import("@/lib/show-pane");
let watch: typeof import("@/lib/verify-watch");
let host: HTMLDivElement;
let root: Root;
const card = { v: 1, runId: "run", owner: "b1", site: "localhost:5173/pricing", status: "completed", mode: "auto", decisionNonce: "nonce", offeredAt: Date.now(), replay: ["run"] };
const chats = {
  bots: [
    { id: "b1", threadId: "t1", name: "Scout", messages: [{ id: "m1", role: "bot", kind: "note", text: "", at: 1, verify: card }], modelSelection: { instanceId: "inst", model: "m" } },
    { id: "b2", threadId: "t2", name: "Juno", messages: [], modelSelection: { instanceId: "inst", model: "m" } },
  ],
  groups: [{ id: "g1", threadId: "gt1", name: "Crew", memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages: [] }],
};

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.last = this;
  }
}

async function until<T>(found: () => T) {
  for (let tries = 0; tries < 100 && !found(); tries++) await act(() => new Promise<void>(done => setTimeout(done, 20)));
  return found();
}
const watchPanel = () => document.querySelector<HTMLElement>("aside[data-verify-watch]:not([data-closing])");
const onTab = (tab: string) => until(() => watchPanel()?.dataset.tab === tab ? watchPanel() : null);
const openTab = () => watchPanel()?.querySelector("[data-pane-tab][data-selected]")?.getAttribute("data-pane-tab");
const toolRows = () => [...watchPanel()?.querySelectorAll<HTMLButtonElement>("[data-pane-tools] [data-pane-tool]") ?? []];
const pick = (id: string) => act(async () => document.querySelector<HTMLElement>(`[data-sidebar-row-id="${id}"] [role=button]`)!.click());
const live = (frame: unknown) => act(async () => FakeEventSource.last!.onmessage?.({ data: JSON.stringify(frame), lastEventId: "" }));

async function toggle() {
  const button = await until(() => document.querySelector<HTMLButtonElement>("button[data-show-pane-button]"));
  await act(async () => button!.click());
}

beforeEach(async () => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ ...chats, selectedId: "b1" }));
  vi.stubGlobal("innerWidth", 1440);
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(prefers-reduced-motion: reduce)" ? { matches: true } as MediaQueryList : matchMedia(query));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  // The pane store keeps tabs and picks in memory too, so every test loads a fresh app.
  vi.resetModules();
  ({ default: App } = await import("./App"));
  pane = await import("@/lib/show-pane");
  watch = await import("@/lib/verify-watch");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  watch.closeVerifyWatch();
  pane.closeShow();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("side pane", () => {
  it("stays open across a bot hop and shows that chat's own tabs", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => pane.showMedia("t1"));
    expect(await onTab("media")).toBeTruthy();
    await pick("b2");
    expect(await until(() => watchPanel()?.querySelector("[data-pane-tools]"))).toBeTruthy();
    expect(watchPanel()?.querySelector("[data-pane-tab]")).toBeNull();
    await pick("b1");
    expect(await onTab("media")).toBeTruthy();
    expect(openTab()).toBe("media");
  });

  it("keeps each chat's last tab across hops, and the header toggle reopens a chat on it", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => pane.showMap("t1"));
    expect(await onTab("map")).toBeTruthy();
    await pick("b2");
    expect(await onTab("tools")).toBeTruthy();
    await act(async () => pane.showTimeline("t2"));
    expect(await onTab("timeline")).toBeTruthy();
    await pick("b1");
    expect(await onTab("map")).toBeTruthy();
    expect(openTab()).toBe("map");
    await pick("b2");
    expect(await onTab("timeline")).toBeTruthy();
    expect(openTab()).toBe("timeline");
    await toggle();
    expect(await until(() => !watchPanel())).toBe(true);
    await toggle();
    expect(await onTab("timeline")).toBeTruthy();
    await toggle();
    expect(await until(() => !watchPanel())).toBe(true);
    await pick("b1");
    expect(watchPanel()).toBeNull();
    await toggle();
    expect(await onTab("map")).toBeTruthy();
    expect(openTab()).toBe("map");
  });

  it.each([["W", "workers"], ["P", "media"], ["C", "check"], ["G", "map"], ["L", "timeline"]] as const)("Alt+%s opens %s as the open tab", async (key, tool) => {
    await act(async () => root.render(createElement(App)));
    await until(() => document.querySelector("button[data-show-pane-button]"));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: `Key${key}`, altKey: true, bubbles: true, cancelable: true })); });
    expect(await onTab(tool)).toBeTruthy();
    expect(openTab()).toBe(tool);
  });

  it("going back to a chat shows the tab left open there, not a file opened before it", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => pane.showItem({ threadId: "t1", path: "C:\\work\\plan.pdf", kind: "pdf" }));
    await act(async () => pane.showMedia("t1"));
    expect(await onTab("media")).toBeTruthy();
    await pick("b2");
    expect(await onTab("tools")).toBeTruthy();
    await pick("b1");
    expect(await onTab("media")).toBeTruthy();
    expect(openTab()).toBe("media");
  });

  it("a pane with only Check open comes back to its chat on Check", async () => {
    await act(async () => root.render(createElement(App)));
    await until(() => document.querySelector("button[data-show-pane-button]"));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC", altKey: true, bubbles: true, cancelable: true })); });
    expect(await onTab("check")).toBeTruthy();
    expect(pane.paneTabs("t1")).toEqual(["check"]);
    await pick("b2");
    expect(await onTab("tools")).toBeTruthy();
    await pick("b1");
    expect(await onTab("check")).toBeTruthy();
    expect(openTab()).toBe("check");
    expect(watchPanel()?.querySelector("[data-pane-tools]")).toBeNull();
  });

  it.each(["textarea[data-orbit-composer]", ".xterm-helper-textarea"])("leaves Alt+P, C, G and L to a focused %s", async (field) => {
    await act(async () => root.render(createElement(App)));
    await until(() => document.querySelector("textarea[data-orbit-composer]"));
    const terminal = Object.assign(document.body.appendChild(document.createElement("div")), { className: "xterm" }).appendChild(Object.assign(document.createElement("textarea"), { className: "xterm-helper-textarea" }));
    const target = document.querySelector<HTMLTextAreaElement>(field)!;
    await act(async () => target.focus());
    for (const key of ["P", "C", "G", "L"]) {
      const press = new KeyboardEvent("keydown", { code: `Key${key}`, altKey: true, bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(press); });
      expect(press.defaultPrevented).toBe(false);
    }
    expect(watchPanel()).toBeNull();
    expect(document.activeElement).toBe(target);
    terminal.parentElement!.remove();
  });

  it("gives every tab one width, so switching to Check never resizes the pane", async () => {
    localStorage.setItem("omb-pane-width", "520");
    await act(async () => root.render(createElement(App)));
    await act(async () => pane.showMedia("t1"));
    const media = await onTab("media");
    expect(media?.dataset.wide).toBe("");
    const width = media?.style.getPropertyValue("--pane-width");
    await act(async () => (await until(() => document.querySelector<HTMLButtonElement>("button[data-verify-watch]")))!.click());
    const check = await onTab("check");
    expect(check?.dataset.wide).toBe("");
    expect(check?.style.getPropertyValue("--pane-width")).toBe(width);
    expect(width).toBe("520px");
  });

  it("closing the last tab leaves the pane open on the tool list", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => pane.showMedia("t1"));
    expect(await onTab("media")).toBeTruthy();
    const close = watchPanel()?.querySelector<HTMLButtonElement>("[data-pane-tab] [data-tab-close]");
    expect(close).toBeTruthy();
    await act(async () => close!.click());
    expect(await onTab("tools")).toBeTruthy();
    expect(watchPanel()?.querySelector("[data-pane-tools]")?.textContent).toContain("Open a tool");
    expect(watchPanel()?.querySelector("[data-pane-tab]")).toBeNull();
  });

  it("shows a tool this chat can't open yet dim with the reason, and it opens nothing", async () => {
    await act(async () => root.render(createElement(App)));
    await pick("b2");
    await toggle();
    expect(await onTab("tools")).toBeTruthy();
    expect(toolRows().map(row => [row.dataset.paneTool, row.getAttribute("aria-disabled"), row.title])).toEqual([
      ["workers", null, ""],
      ["media", null, ""],
      ["check", "true", "Shows once this chat has a check"],
      ["map", null, ""],
      ["timeline", null, ""],
    ]);
    await act(async () => watchPanel()!.querySelector<HTMLButtonElement>("[data-pane-tool=check]")!.click());
    expect(watchPanel()?.dataset.tab).toBe("tools");
    expect(watchPanel()?.querySelector("[data-pane-tab]")).toBeNull();
  });

  it("leaves out the tools a group never has, and dims the ones it has nothing for yet", async () => {
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ ...chats, selectedId: "g1" }));
    await act(async () => root.render(createElement(App)));
    await toggle();
    expect(await onTab("tools")).toBeTruthy();
    expect(toolRows().map(row => [row.dataset.paneTool, row.getAttribute("aria-disabled"), row.title])).toEqual([
      ["workers", "true", "Shows once a helper works in this chat"],
      ["media", null, ""],
      ["check", "true", "Shows once this chat has a check"],
    ]);
  });

  it("opens a file a bot hands over as a tab named after it, and leaves the keyboard in the chat box", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/bots?messages=200") return new Response(JSON.stringify(chats));
      if (String(url).includes("/linked-file?")) return new Response(null, { status: 206 });
      return new Promise<Response>(() => {});
    }));
    await act(async () => root.render(createElement(App)));
    await live({ kind: "hello", resumed: false, cursor: "c0" });
    const composer = await until(() => document.querySelector<HTMLTextAreaElement>("textarea[data-orbit-composer]"));
    await act(async () => composer!.focus());
    expect(document.activeElement).toBe(composer);
    await live({ kind: "message", threadId: "t1", message: { id: "deck", role: "bot", kind: "text", text: "Done: [launch-deck.pdf](C:\\work\\launch-deck.pdf)", at: 3 } });
    const tab = await until(() => watchPanel()?.querySelector<HTMLElement>("[data-pane-tab][data-selected]"));
    expect(tab?.textContent).toBe("launch-deck.pdf");
    for (const settled = Date.now() + PRESENCE_EXIT_MS + MOTION_MODERATE_MS + 100; Date.now() < settled;) {
      expect(document.activeElement).toBe(composer);
      await act(() => new Promise<void>(done => setTimeout(done, 20)));
    }
    expect(document.activeElement).toBe(composer);
  });
});
