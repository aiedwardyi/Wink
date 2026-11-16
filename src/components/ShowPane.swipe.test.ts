// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetMedia } from "@/lib/media-index";
import { SWIPE_MOTION_MS } from "@/lib/phone-swipe";
import { closeShow, showItem, showMap, showMedia, useMapThread, useMediaThread, useShowItem } from "@/lib/show-pane";
import { ShowPane } from "./ShowPane";

const source = { threadId: "pane-swipe", messages: [] };
const shown = { threadId: source.threadId, path: "C:\\test\\page.png", kind: "image" as const };
let host: HTMLElement;
let root: Root;
let time = 0;
const pane = () => document.querySelector<HTMLElement>(".show-pane")!;
const current = () => pane().querySelector<HTMLElement>("[data-pane-current]") ?? pane();
const selected = () => pane().querySelector('.show-pane-tabs [aria-selected="true"]')?.textContent;

function Harness({ botId }: { botId?: string }) {
  const item = useShowItem();
  const media = useMediaThread();
  const map = useMapThread();
  return item || media || map ? createElement(ShowPane, { item: item ?? undefined, media: Boolean(media), map: Boolean(map), botId, source, hidden: false }) : null;
}

function touch(type: string, x: number, y: number, target: Element) {
  time += 1000;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
  return event;
}

async function swipe(left: boolean, target: Element = current()) {
  await act(async () => touch("touchstart", left ? 350 : 20, 200, target));
  await act(async () => touch("touchmove", left ? 20 : 350, 200, target));
  await act(async () => { touch("touchend", left ? 20 : 350, 200, target); vi.advanceTimersByTime(SWIPE_MOTION_MS); });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 392);
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { get: () => query.includes("max-width") });
    return media;
  });
  vi.stubGlobal("EventSource", class { onmessage = null; onerror = null; readyState = 0; close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ v: "1", ids: ["p", "f"], at: [1, 1], kind: "ll", name: ["photo.png", "notes.txt"], ref: ["C:\\test\\photo.png", "C:\\test\\notes.txt"], size: [10, 20] })));
  time = 0;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  showItem(shown);
  await act(async () => root.render(createElement(Harness, { botId: "pane-bot" })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  closeShow();
  forgetMedia();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("moves Show to Media and keeps pane touches out of the chat container", async () => {
  const botSwipe = vi.fn();
  host.addEventListener("touchmove", botSwipe);
  expect(selected()).toBe("Show");
  await swipe(true);
  expect(selected()).toBe("Media");
  expect(botSwipe).not.toHaveBeenCalled();
});

it("visits Photos then Files before Map and returns through Media", async () => {
  await act(async () => showMedia(source.threadId));
  expect(pane().querySelector('.show-media-kinds [aria-selected="true"]')?.textContent).toBe("Photos");
  await swipe(true);
  expect(selected()).toBe("Media");
  expect(pane().querySelector('.show-media-kinds [aria-selected="true"]')?.textContent).toBe("Files");
  await swipe(true);
  expect(selected()).toBe("Map");
  await swipe(false, pane().querySelector(".show-pane-head")!);
  expect(selected()).toBe("Media");
});

it("stops a room at Media because rooms have no Map", async () => {
  await act(async () => root.render(createElement(Harness, {})));
  await act(async () => showMedia(source.threadId));
  await swipe(true);
  expect(pane().querySelector('.show-media-kinds [aria-selected="true"]')?.textContent).toBe("Files");
  await swipe(true);
  expect(selected()).toBe("Media");
  expect(pane().dataset.tab).toBe("media");
});

it("closes toward the right only from the first available tab", async () => {
  await swipe(false);
  expect(document.querySelector(".show-pane")).toBeNull();
});

it("keeps a replacement file open when the old file was being dismissed", async () => {
  const target = current();
  await act(async () => {
    touch("touchstart", 30, 200, target);
    touch("touchmove", 350, 200, target);
    touch("touchend", 350, 200, target);
  });
  await act(async () => showItem({ ...shown, path: "C:\\test\\replacement.png" }));
  await act(async () => vi.advanceTimersByTime(SWIPE_MOTION_MS));
  expect(document.querySelector(".show-pane")).not.toBeNull();
  expect(document.querySelector(".show-frame-name")?.textContent).toBe("replacement.png");
});

it("lets Map own content starts and pages from the pane header", async () => {
  await act(async () => { await import("./MapPane"); showMap(source.threadId); });
  const map = pane().querySelector(".map-pane")!;
  expect(map).not.toBeNull();
  await swipe(false, map);
  expect(selected()).toBe("Map");
  await swipe(false, pane().querySelector(".show-pane-head")!);
  expect(selected()).toBe("Media");
});

it("keeps vertical movement out of the tab pager", async () => {
  const target = current();
  await act(async () => {
    touch("touchstart", 100, 400, target);
    expect(touch("touchmove", 105, 100, target).defaultPrevented).toBe(false);
    touch("touchend", 105, 100, target);
    vi.advanceTimersByTime(SWIPE_MOTION_MS);
  });
  expect(selected()).toBe("Show");
});
