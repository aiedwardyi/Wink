// @vitest-environment happy-dom
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

import { landFold, spyReveal } from "./Fold.test-land";

// oxlint-disable-next-line anti-slop/no-module-mocking -- the panel reads only dispatch from the shared store.
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- the live stream needs a server.
vi.mock("@/lib/live-events", () => ({ openLiveEvents: () => () => undefined }));
import { InspectorPanel } from "./InspectorPanel";

let host: HTMLDivElement;
let root: Root;

// SAFETY: the panel reads only the bot's thread id.
const bot = { threadId: "t1" } as Bot;
const event = (eventId: string) => ({ kind: "runtime", at: "2026-11-20T00:00:00.000Z", data: { eventId, type: "turn.started", threadId: "t1", createdAt: "2026-11-20T00:00:00.000Z" } });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ entries: [event("e1"), event("e2")], total: { runtime: 2, native: 0 } })));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("brings an opened row's data into view once it has landed, never while closing", async () => {
  await act(async () => root.render(createElement(InspectorPanel, { bot })));
  const scrolled = spyReveal();
  try {
    const toggle = () => host.querySelectorAll<HTMLButtonElement>(".font-mono > div > button")[1]!;
    await act(async () => toggle().click());
    expect(scrolled).not.toHaveBeenCalled();
    await landFold(host.querySelector("pre")!);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(host.querySelector("pre"));
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
    vi.useFakeTimers();
    await act(async () => toggle().click());
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS));
    vi.useRealTimers();
    expect(scrolled).toHaveBeenCalledTimes(1);
  } finally {
    scrolled.mockRestore();
  }
});
