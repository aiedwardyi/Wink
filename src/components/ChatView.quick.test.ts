// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";

import { ChatView } from "./ChatView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot = (messages: Message[], busy = false): Bot => ({
  id: "helper", threadId: "thread-helper", name: "Helper", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy, activity: busy ? "working" : "idle", modelSelection: { instanceId: "inst", model: "m" }, messages,
});

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  applySkin("precision");
});

async function mount(current: Bot) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next: Bot) => {
    await act(async () => root.render(createElement(I18nProvider, null,
      createElement(StoreProvider, null, createElement(ChatView, { bot: next })),
    )));
  };
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await render(current);
  await act(async () => {
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" });
  });
  return { host, render };
}

const ask = (id: string, at: number, quick: Message["quick"] = { state: "asked" }): Message => ({ id, at, role: "user", kind: "text", text: `ask ${id}`, quick });
const answer = (id: string, askId: string, at: number): Message => ({ id, at, role: "bot", kind: "text", text: `answer ${id}`, quick: { state: "answer", askId } });
const reply = (id: string, at: number, role: Message["role"] = "bot"): Message => ({ id, at, role, kind: "text", text: id });
const row = (host: HTMLElement, id: string) => host.querySelector(`[data-mid="${id}"]`);
const hasQuote = (host: HTMLElement, id: string) => Boolean(row(host, id)?.querySelector("button[title='Jump to original message']"));

describe("ChatView quick answers", () => {
  it.each([
    ["en", "Quick answer", "Answered by a read-only copy of Helper while it works. Helper sees it before its next step."],
    ["ko", "빠른 답변", "Helper이(가) 작업하는 동안 읽기 전용 사본이 대신 답했습니다. Helper은(는) 다음 단계 전에 이 답을 확인합니다."],
  ])("labels the answer in %s", async (locale, label, title) => {
    localStorage.setItem("omb-locale", locale);
    const { host } = await mount(bot([ask("q", 1), answer("a", "q", 2)], true));
    const found = Array.from(row(host, "a")!.querySelectorAll("[title]")).find((el) => el.textContent === label);
    expect(found?.getAttribute("title")).toBe(title);
  });

  it("keeps Copy and drops Reply and Regenerate on a quick answer", async () => {
    const { host } = await mount(bot([ask("q", 1), answer("a", "q", 2)]));
    const actions = row(host, "a")!.querySelector("[data-message-hover-actions]")!;
    expect(actions.querySelector("[aria-label='Copy message']")).not.toBeNull();
    expect(actions.querySelector("[aria-label='Reply to message']")).toBeNull();
    expect(actions.querySelector("[aria-label='Regenerate response']")).toBeNull();
  });

  it("gives Reply and Regenerate to the real last reply, not a quick answer after it", async () => {
    const { host } = await mount(bot([ask("q", 1), reply("final", 2), answer("a", "q", 3)]));
    const actions = row(host, "final")!.querySelector("[data-message-hover-actions]")!;
    expect(actions.querySelector("[aria-label='Reply to message']")).not.toBeNull();
    expect(actions.querySelector("[aria-label='Regenerate response']")).not.toBeNull();
  });

  it("shows a typing row under a pending ask, only while the bot works", async () => {
    const { host, render } = await mount(bot([ask("q", 1)], true));
    expect(row(host, "q")!.querySelector("[data-quick-typing]")?.textContent).toBe("Quick answer");
    await render(bot([ask("q", 1)], false));
    expect(host.querySelector("[data-quick-typing]")).toBeNull();
  });

  it("drops the typing row when the answer lands", async () => {
    const { host } = await mount(bot([ask("q", 1), answer("a", "q", 2)], true));
    expect(host.querySelector("[data-quick-typing]")).toBeNull();
  });

  it("shows a handed-off ask as sent mid-turn with no typing row", async () => {
    const { host } = await mount(bot([{ ...ask("q", 1, { state: "handoff" }), steered: true }], true));
    expect(row(host, "q")?.textContent).toContain("sent mid-turn");
    expect(host.querySelector("[data-quick-typing]")).toBeNull();
  });

  it("quotes the ask only when it is not the text row right above", async () => {
    const { host } = await mount(bot([
      ask("q1", 1), answer("a1", "q1", 2),
      ask("q2", 3), reply("other", 4, "user"), answer("a2", "q2", 5),
    ], true));
    expect(hasQuote(host, "a1")).toBe(false);
    expect(hasQuote(host, "a2")).toBe(true);
    expect(row(host, "a2")?.textContent).toContain("ask q2");
  });
});
