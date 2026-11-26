// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveFrame } from "@/lib/live-events";
import { StoreProvider, useStreaming, type Bot, type Group, type Message } from "@/state/store";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

const renders = vi.hoisted(() => ({ composer: 0, picker: 0 }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- counts the real Composer's renders; it still renders.
vi.mock("./Composer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Composer")>();
  return { ...actual, Composer: (props: Parameters<typeof actual.Composer>[0]) => { renders.composer++; return createElement(actual.Composer, props); } };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- counts the real ModelPicker's renders; it still renders.
vi.mock("./ModelPicker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ModelPicker")>();
  return { ...actual, ModelPicker: (props: Parameters<typeof actual.ModelPicker>[0]) => { renders.picker++; return createElement(actual.ModelPicker, props); } };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Markdown highlighting is not what this test checks.
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const FRAMES = 60;
const user = (id: string): Message => ({ id, at: 1, role: "user", kind: "text", text: "Write a lot" });
const bot = (id: string, busy: boolean): Bot => ({
  id, threadId: `thread-${id}`, name: id.toUpperCase(), title: "", description: "", notifications: false, color: "blue", unread: false,
  busy, activity: busy ? "working" : "idle", modelSelection: { instanceId: "inst", model: "m" }, messages: [user(`u-${id}`)],
});
const room = (member: Bot): Group => ({
  id: "g", threadId: "thread-g", name: "Room", memberIds: [member.id], defaultResponder: { kind: "everyone" },
  bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1, busyBotId: member.id, messages: [user("u-g")],
});

let stream: ReturnType<typeof useStreaming>;
let unmount: (() => Promise<void>) | null = null;

beforeEach(() => {
  localStorage.setItem("omb-reply-style", "live");
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount?.();
  unmount = null;
  FakeEventSource.last = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function emit(frame: LiveFrame) {
  await act(async () => FakeEventSource.last!.onmessage!({ data: JSON.stringify(frame), lastEventId: "" }));
}

async function mount(bots: Bot[], groups: Group[], view: ReturnType<typeof createElement>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots, groups, computerControl: {} })
    : new Response("{}", { status: 404 })));
  function Probe() {
    stream = useStreaming();
    return null;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, view, createElement(Probe))));
  await emit({ kind: "hello", resumed: false, cursor: "s:0" });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

// One delta per frame, typed out as it lands.
async function streamInto(threadId: string) {
  await emit({ kind: "runtime", event: { type: "turn.started", threadId, turnId: `turn-${threadId}` } });
  await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  const before = { ...renders };
  for (let i = 0; i < FRAMES; i++) {
    await emit({ kind: "runtime", event: { type: "content.delta", threadId, turnId: `turn-${threadId}`, streamKind: "assistant_text", delta: "word ".repeat(3) } });
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  }
  expect(stream.streaming[threadId]?.length).toBeGreaterThan(100);
  return { composer: renders.composer - before.composer, picker: renders.picker - before.picker };
}

describe("open chat while replies stream", () => {
  it("does not re-render an idle chat's header or composer for another chat's stream", async () => {
    const a = bot("a", false);
    await mount([a, bot("b", true)], [], createElement(ChatView, { bot: a }));
    expect(renders.composer).toBeGreaterThan(0);
    expect(await streamInto("thread-b")).toEqual({ composer: 0, picker: 0 });
  });

  it("re-renders its own header and composer a bounded number of times while its reply streams", async () => {
    const a = bot("a", true);
    const host = await mount([a], [], createElement(ChatView, { bot: a }));
    const counts = await streamInto("thread-a");
    expect(host.querySelector("[data-live-step]")?.textContent).toContain("word word");
    expect(counts.composer).toBeLessThanOrEqual(4);
    expect(counts.picker).toBeLessThanOrEqual(4);
  });

  it("does not re-render an idle room's composer for another chat's stream", async () => {
    const member = bot("m", false);
    const group = { ...room(member), busyBotId: null };
    await mount([member, bot("b", true)], [group], createElement(GroupView, { group }));
    expect(renders.composer).toBeGreaterThan(0);
    expect((await streamInto("thread-b")).composer).toBe(0);
  });

  it("re-renders a room's composer a bounded number of times while its reply streams", async () => {
    const member = bot("m", true);
    const group = room(member);
    const host = await mount([member], [group], createElement(GroupView, { group }));
    const counts = await streamInto("thread-g");
    expect(host.querySelector('[data-mid="stream:thread-g:u-g"]')?.textContent).toContain("word word");
    expect(counts.composer).toBeLessThanOrEqual(4);
  });
});
