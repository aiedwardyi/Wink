// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useStore } from "@/state/store";

const store = vi.hoisted(() => ({ state: null as ReturnType<typeof useStore>["state"] | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => {
    const value = actual.useStore();
    store.state = value.state;
    return value;
  } };
});
vi.mock("../shared/live-verify", async importOriginal => ({ ...await importOriginal<typeof import("../shared/live-verify")>(), LIVE_VERIFY_V0: true }));

import App from "./App";
import { FORUM_SELECTION } from "@/lib/board";
import { closeShow } from "@/lib/show-pane";
import { closeVerifyWatch } from "@/lib/verify-watch";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

let host: HTMLDivElement;
let root: Root;

const forumGone = () => until(() => !document.querySelector("[data-board-view]"));
const selected = () => store.state!.selectedId;
const paneButton = () => document.querySelector<HTMLButtonElement>("button[data-show-pane-button]");
const pane = () => document.querySelector("aside[data-verify-watch]:not([data-closing])");
const forumButton = () => act(async () => document.querySelector<HTMLButtonElement>("[data-board-button]")!.click());
const esc = (target: EventTarget = document.body) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

async function until<T>(found: () => T) {
  for (let tries = 0; tries < 100 && !found(); tries++) await act(() => new Promise<void>(done => setTimeout(done, 20)));
  return found();
}
async function openPane() {
  await act(async () => (await until(paneButton) as HTMLButtonElement).click());
  expect(await until(pane)).toBeTruthy();
}
async function openForum() {
  await forumButton();
  expect(await until(() => document.querySelector("[data-board-view]:not([data-closing])"))).toBeTruthy();
  expect(selected()).toBe(FORUM_SELECTION);
}

beforeEach(async () => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [
      { id: "b1", threadId: "t1", name: "Scout", messages: [], modelSelection: { instanceId: "inst", model: "m" } },
      { id: "b2", threadId: "t2", name: "Juno", messages: [], modelSelection: { instanceId: "inst", model: "m" } },
    ],
    groups: [],
    selectedId: "b2",
  }));
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn((url: string) => String(url).includes("/api/board")
    ? Promise.resolve(new Response(JSON.stringify({ posts: [] }), { headers: { "content-type": "application/json" } }))
    : new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(App)));
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

describe("leaving the Forum on desktop", () => {
  it.each([["Esc, Esc", ["esc", "esc"]], ["the button, then Esc", ["button", "esc"]], ["Esc, then the button", ["esc", "button"]]] as const)("%s during the slide-out ends on the same chat with the Forum closed", async (_name, presses) => {
    await openForum();
    for (const press of presses) await (press === "esc" ? esc() : forumButton());
    expect(document.querySelector("[data-board-view]")?.hasAttribute("data-closing")).toBe(true);
    await forumGone();
    expect(selected()).toBe("b2");
    expect(document.querySelector("[data-board-view]")).toBeNull();
  });

  it.each(["Esc", "the button"])("%s brings the open side pane back", async (how) => {
    await openPane();
    await openForum();
    await (how === "Esc" ? esc() : forumButton());
    await forumGone();
    expect(selected()).toBe("b2");
    expect(await until(pane)).toBeTruthy();
  });

  it("a closed side pane stays closed", async () => {
    await openForum();
    await esc();
    await forumGone();
    expect(selected()).toBe("b2");
    expect(pane()).toBeNull();
  });

  it("the side pane still closes when another chat is picked from the Forum", async () => {
    await openPane();
    await openForum();
    await act(async () => document.querySelector<HTMLElement>('[data-sidebar-row-id="b1"] [role=button]')!.click());
    await forumGone();
    expect(selected()).toBe("b1");
    expect(pane()).toBeNull();
  });

  it("Esc in the sidebar search stays in the Forum", async () => {
    await openForum();
    await esc(document.querySelector("[data-sidebar-search] input")!);
    await forumGone();
    expect(selected()).toBe(FORUM_SELECTION);
  });
});
