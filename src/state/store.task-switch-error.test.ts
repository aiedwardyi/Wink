// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { StoreProvider, useStore, type Bot, type Group } from "./store";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close() {}
  constructor() { FakeEventSource.last = this; }
}

const bot = { id: "b1", threadId: "t-bot", name: "Atlas", busy: false, activity: "idle", messages: [], modelSelection: { instanceId: "inst", model: "m" } } as unknown as Bot;
const group = { id: "g1", threadId: "t-group", name: "Room", memberIds: [bot.id], busyBotId: null, messages: [] } as unknown as Group;
let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  applyLocale("en");
});

it.each([
  ["bot", "en"], ["channel", "en"], ["bot", "ko"], ["channel", "ko"],
] as const)("shows the rejected %s send in the %s banner after removing its optimistic row", async (target, locale) => {
  applyLocale(locale);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/bots?messages=200") return Response.json({ bots: [bot], groups: [group], computerControl: {} });
    if (init?.method === "POST") return Response.json({ error: `the ${target} switched tasks before it could receive the message` }, { status: 409 });
    if (url.startsWith("/api/threads/")) return Response.json({ messages: [], hasMore: false });
    return Response.json({ error: "not in this test" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store!: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    return createElement("div", { role: "alert" }, store.state.error);
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" }));
  await vi.waitFor(() => expect(store.state.bots).toHaveLength(1));
  const onError = vi.fn();
  const threadId = target === "bot" ? bot.threadId : group.threadId;
  await act(async () => store.dispatch(target === "bot"
    ? { type: "send", botId: bot.id, threadId, text: "hello", sendId: "s1", onError }
    : { type: "sendGroup", groupId: group.id, threadId, text: "hello", sendId: "s1", onError }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  expect(store.state.acceptedSends[threadId]).toBeUndefined();
  expect(target === "bot" ? store.state.bots[0].messages : store.state.groups[0].messages).toEqual([]);
  const expected = locale === "en" ? "Not sent. The chat moved to another task. Send your message again." : "전송되지 않았어요. 채팅이 다른 작업으로 바뀌었어요. 메시지를 다시 보내 주세요.";
  expect(store.state.error).toBe(expected);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(expected);
});
