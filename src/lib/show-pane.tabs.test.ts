// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { closeShow, closeTab, moveTab, paneTabs, showItem, showMap, showMedia, showTimeline, togglePane, useAutoShow, useMapThread, useMediaThread, useShowItem, useTimelineThread, useToolsThread, type ShowItem } from "./show-pane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (id: string): Message => ({ id, role: "user", kind: "text", text: "make it", at: 1 });
const handOver: Message = { id: "b1", role: "bot", kind: "text", text: "Done: [launch-deck.pdf](C:\\work\\launch-deck.pdf)", at: 2 };
const deck = (threadId: string): ShowItem => ({ threadId, path: "C:\\work\\launch-deck.pdf", kind: "pdf" });

let host: HTMLDivElement;
let root: Root;
let open: unknown[] = [];

function Probe({ thread, messages }: { thread: string; messages: Message[] }) {
  useAutoShow(thread, messages, true);
  open = [useShowItem(), useMediaThread(), useMapThread(), useTimelineThread(), useToolsThread()];
  return null;
}

const render = (thread: string, messages: Message[] = []) => act(async () => root.render(createElement(Probe, { thread, messages })));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 206 })));
  host = document.createElement("div");
  root = createRoot(host);
  open = [];
});
afterEach(() => { act(() => root.unmount()); act(() => closeShow()); localStorage.clear(); vi.unstubAllGlobals(); });

it("keeps each chat's tabs, their order and its open tab across a reload", async () => {
  await act(async () => {
    showMedia("t1");
    showItem(deck("t1"));
    showMap("t1");
    moveTab("t1", "map", "media");
    showItem(deck("t1"));
    showTimeline("t2");
    showMedia("t2");
    moveTab("t2", "timeline", null);
    showTimeline("t2");
    closeShow();
  });
  vi.resetModules();
  const restarted = await import("./show-pane");
  expect(restarted.paneTabs("t1")).toEqual(["map", "media", deck("t1")]);
  expect(restarted.paneTabs("t2")).toEqual(["media", "timeline"]);
  let seen: unknown[] = [];
  const After = () => { seen = [restarted.useShowItem(), restarted.useTimelineThread()]; return null; };
  await act(async () => root.render(createElement(After)));
  await act(async () => restarted.togglePane("t1", "idle"));
  expect(seen).toEqual([deck("t1"), null]);
  await act(async () => restarted.togglePane("t1", "idle"));
  await act(async () => restarted.togglePane("t2", "idle"));
  expect(seen).toEqual([null, "t2"]);
});

it("closing the open tab makes its neighbour the chat's last tab, and closing the last one shows the tool list", async () => {
  await act(async () => { showTimeline("t3"); showMedia("t3"); showMap("t3"); closeTab("t3", "map", "media"); });
  await render("t3");
  expect(open).toEqual([null, "t3", null, null, null]);
  await act(async () => closeShow());
  await act(async () => togglePane("t3", "idle"));
  expect(open).toEqual([null, "t3", null, null, null]);
  await act(async () => closeTab("t3", "timeline", null));
  expect(open).toEqual([null, "t3", null, null, null]);
  await act(async () => closeTab("t3", "media", null));
  expect(open).toEqual([null, null, null, null, "t3"]);
  expect(paneTabs("t3")).toEqual([]);
});

it("a file that opens on its own becomes a tab but not the chat's last tab, and a click makes it one", async () => {
  await act(async () => { showMap("t4"); closeShow(); });
  expect(paneTabs("t4")).toEqual(["map"]);
  await render("t4", [user("u1")]);
  await render("t4", [user("u1"), handOver]);
  expect(open[0]).toEqual(deck("t4"));
  expect(paneTabs("t4")).toEqual(["map", deck("t4")]);
  await act(async () => closeShow());
  await act(async () => togglePane("t4", "idle"));
  expect(open).toEqual([null, null, "t4", null, null]);
  await act(async () => closeShow());
  await act(async () => showItem(deck("t4")));
  await act(async () => closeShow());
  await act(async () => togglePane("t4", "idle"));
  expect(open).toEqual([deck("t4"), null, null, null, null]);
});
