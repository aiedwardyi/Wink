// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { closeShow, showItem } from "@/lib/show-pane";
import { closeVerifyWatch } from "@/lib/verify-watch";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { SIDEBAR_COLLAPSED_KEY, SIDEBAR_WIDTH_KEY } from "@/lib/sidebar-preferences";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

vi.mock("../shared/live-verify", async importOriginal => ({ ...await importOriginal<typeof import("../shared/live-verify")>(), LIVE_VERIFY_V0: true }));

let host: HTMLDivElement;
let root: Root;
const card = { v: 1, runId: "run", owner: "b1", site: "localhost:5173/pricing", status: "completed", mode: "auto", decisionNonce: "nonce", offeredAt: Date.now(), replay: ["run"] };

const wait = (ms: number) => act(() => new Promise<void>(done => setTimeout(done, ms)));
async function until(found: () => Element | null | undefined) {
  for (let tries = 0; tries < 100 && !found(); tries++) await wait(20);
  return found();
}
const watchPanel = () => document.querySelector("aside[data-verify-watch]:not([data-closing])");
const detailsPanel = () => document.querySelector("[data-settings-panel]:not([data-closing])");
const inspectorPanel = () => [...document.querySelectorAll("aside[data-side-panel]:not([data-closing])")].find(aside => aside.textContent?.includes("Inspector"));
const botList = () => document.querySelector<HTMLElement>("aside[data-phone-drawer]")!;
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;
const pick = (id: string) => act(async () => document.querySelector<HTMLElement>(`[data-sidebar-row-id="${id}"] [role=button]`)!.click());

async function openWatch() {
  await act(async () => (await until(() => button("button[data-verify-watch]")) as HTMLButtonElement).click());
  expect(await until(watchPanel)).toBeTruthy();
}
async function openDetails() {
  await act(async () => button('button[aria-label="Open Scout\'s profile"]').click());
  expect(await until(detailsPanel)).toBeTruthy();
}
async function openInspector() {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })));
  const option = await until(() => [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find(each => each.textContent?.includes("Open Inspector")));
  await act(async () => (option as HTMLButtonElement).click());
  expect(await until(inspectorPanel)).toBeTruthy();
}

beforeEach(() => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [
      { id: "b1", threadId: "t1", name: "Scout", messages: [{ id: "m1", role: "bot", kind: "note", text: "", at: 1, verify: card }], modelSelection: { instanceId: "inst", model: "m" } },
      { id: "b2", threadId: "t2", name: "Juno", messages: [], modelSelection: { instanceId: "inst", model: "m" } },
    ],
    groups: [],
    selectedId: "b1",
  }));
  vi.stubGlobal("innerWidth", 1440);
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(prefers-reduced-motion: reduce)" ? { matches: true } as MediaQueryList : matchMedia(query));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  closeVerifyWatch();
  closeShow();
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("right slot", () => {
  it("opening one panel closes whichever is open", async () => {
    await act(async () => root.render(createElement(App)));
    await openWatch();
    await openDetails();
    expect(watchPanel()).toBeNull();
    await openWatch();
    expect(detailsPanel()).toBeNull();
    await openInspector();
    expect(watchPanel()).toBeNull();
    await openDetails();
    expect(inspectorPanel()).toBeUndefined();
  });

  it("the checker docks as the pane's Check tab, and Show keeps its file", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => showItem({ threadId: "t1", path: "C:\\w\\a.png", kind: "image" }));
    await openWatch();
    const tabs = () => [...document.querySelectorAll(".show-pane-tabs [role=tab]")].map(tab => `${tab.textContent}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`);
    expect(tabs()).toEqual(["Show", "Media", "Check*", "Map"]);
    const img = document.querySelector(".show-pane img");
    expect(img).toBeTruthy();
    await act(async () => button(".show-pane-tabs [role=tab]").click());
    expect(tabs()).toEqual(["Show*", "Media", "Check", "Map"]);
    expect(document.querySelector(".show-pane img")).toBe(img);
    expect(document.querySelector(".show-pane .verify-watch-url")).toBeTruthy();
  });

  it("has no Check tab in a chat with no check", async () => {
    await act(async () => root.render(createElement(App)));
    await pick("b2");
    await act(async () => (await until(() => button("button[data-show-pane-button]")) as HTMLButtonElement).click());
    await until(watchPanel);
    expect([...document.querySelectorAll(".show-pane-tabs [role=tab]")].map(tab => tab.textContent)).toEqual(["Show", "Media", "Map"]);
  });

  it("picking another bot closes the slot, and the same bot again keeps it", async () => {
    await act(async () => root.render(createElement(App)));
    await openDetails();
    await pick("b1");
    expect(detailsPanel()).toBeTruthy();
    await pick("b2");
    await wait(PRESENCE_EXIT_MS + 40);
    expect(detailsPanel()).toBeNull();
    await pick("b1");
    await openInspector();
    await pick("b2");
    await wait(PRESENCE_EXIT_MS + 40);
    expect(inspectorPanel()).toBeUndefined();
    await pick("b1");
    await openWatch();
    await pick("b2");
    await pick("b1");
    await wait(PRESENCE_EXIT_MS + 40);
    expect(watchPanel()).toBeNull();
  });

  it("folds the bot list to faces while open and restores its width on close", async () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, "300");
    await act(async () => root.render(createElement(App)));
    expect(botList().style.width).toBe("300px");
    await openWatch();
    expect(botList().style.width).toBe("64px");
    await openDetails();
    expect(botList().style.width).toBe("64px");
    await act(async () => button('button[aria-label="Close Bot Details"]').click());
    await wait(PRESENCE_EXIT_MS + 40);
    expect(botList().style.width).toBe("300px");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();
  });

  it("search on the folded list closes the slot and opens search", async () => {
    await act(async () => root.render(createElement(App)));
    await openDetails();
    await act(async () => button('button[aria-label="Search bots and messages"]').click());
    await wait(PRESENCE_EXIT_MS + 40);
    expect(detailsPanel()).toBeNull();
    expect(document.querySelector('input[aria-label="Search bots and messages"]')).toBeTruthy();
  });

  it("keeps a bot list the user collapsed collapsed after the slot closes", async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    await act(async () => root.render(createElement(App)));
    expect(botList().style.width).toBe("64px");
    await openDetails();
    await act(async () => button('button[aria-label="Close Bot Details"]').click());
    await wait(PRESENCE_EXIT_MS + 40);
    expect(botList().style.width).toBe("64px");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
  });
});
