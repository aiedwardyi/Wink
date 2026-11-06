// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifyCardData } from "../../shared/live-verify";
import { VerifyWatchFrame } from "./VerifyWatch";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("../../shared/live-verify", async importOriginal => ({ ...await importOriginal<typeof import("../../shared/live-verify")>(), get LIVE_VERIFY_V0() { return flag.on; } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: VerifyCardData = { v: 1, runId: "run-1", owner: "bot", site: "luna/index.html", status: "running", mode: "auto", decisionNonce: "n", offeredAt: Date.now(), startedAt: Date.now(), live: true, replay: ["old-1", "old-2"] };
let root: Root;
let host: HTMLElement;
let calls: Array<{ url: string; signal: AbortSignal }>;
let visibility: DocumentVisibilityState;

beforeEach(() => {
  calls = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, signal: init.signal! });
    if (url.includes("old-")) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); } })));
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = (props: { live: boolean; hidden: boolean }) => act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", onClose: () => {}, ...props })));
const flipVisibility = (next: DocumentVisibilityState) => act(async () => { visibility = next; document.dispatchEvent(new Event("visibilitychange")); });

it("streams live only while the chat is shown and the window is visible, aborting on each change", async () => {
  await render({ live: true, hidden: true });
  expect(calls).toHaveLength(0);
  await render({ live: true, hidden: false });
  expect(calls.map(c => c.url)).toEqual(["/api/verify/runs/run-1/live"]);
  await render({ live: true, hidden: true });
  expect(calls[0]!.signal.aborted).toBe(true);
  expect(calls).toHaveLength(1);
  await render({ live: true, hidden: false });
  expect(calls).toHaveLength(2);
  await flipVisibility("hidden");
  expect(calls[1]!.signal.aborted).toBe(true);
  await flipVisibility("visible");
  expect(calls).toHaveLength(3);
  act(() => root.unmount());
  expect(calls[2]!.signal.aborted).toBe(true);
  root = createRoot(host);
});

it("plays the card's kept runs from the replay route and says Replay expired on 404", async () => {
  await render({ live: false, hidden: false });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(calls.map(c => c.url)).toEqual(["/api/verify/runs/old-1/replay"]);
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
  expect(host.textContent).toContain("Replay expired");
  expect(host.querySelector(".verify-watch-url")?.textContent).toBe("luna/index.html");
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
});
