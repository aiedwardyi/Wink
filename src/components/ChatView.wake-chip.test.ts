// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Routine } from "@/lib/routines";
import { StoreProvider, useStore, type Bot, type Group } from "@/state/store";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const bot = {
  id: "kai", threadId: "thread-kai", name: "Kai", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages: [], hasMore: false,
} as unknown as Bot;

const group: Group = {
  id: "g1", threadId: "thread-g1", name: "Crew", memberIds: ["kai"], defaultResponder: { kind: "everyone" },
  bulletin: "", unread: false, createdAt: 1, setupCompletedAt: null, setupSkippedAt: 1, hasMore: false, messages: [],
};

const wake = (botId: string, threadId: string): Routine => ({
  id: "wake-1", name: "Wake", prompt: "check the deploy", botId, runOn: "maus", enabled: true, wake: true, sourceThreadId: threadId,
  schedule: { type: "once", at: Date.now() + 3_600_000 }, durationMinutes: 30, nextRunAt: Date.now() + 3_600_000, createdAt: 1, updatedAt: 1,
});

function Seed({ routine }: { routine: Routine }) {
  const { dispatch } = useStore();
  useEffect(() => {
    dispatch({ type: "routinesHydrated", routines: [routine], runs: [] } as never);
  }, [dispatch, routine]);
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mountWith(routine: Routine, view: ReturnType<typeof createElement>) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Seed, { routine }), view)));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("a pending wake_me wake", () => {
  it("shows no chip above the message box in a chat", async () => {
    const { host, unmount } = await mountWith(wake(bot.id, bot.threadId), createElement(ChatView, { bot }));
    try {
      expect(host.querySelector("textarea, [contenteditable]")).not.toBeNull();
      expect(host.querySelector("[data-wake-chip]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("shows no chip above the message box in a room", async () => {
    const { host, unmount } = await mountWith(wake("kai", group.threadId), createElement(GroupView, { group }));
    try {
      expect(host.querySelector("textarea, [contenteditable]")).not.toBeNull();
      expect(host.querySelector("[data-wake-chip]")).toBeNull();
    } finally {
      await unmount();
    }
  });
});
