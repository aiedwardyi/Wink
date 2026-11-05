// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { StoreProvider, type Bot, type Group, type Message } from "@/state/store";

import { ChatView } from "./ChatView";
import { Transcript } from "./GroupView";

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

// the row server/comms-notice.ts appends: no tool.ok, no comm, so it stays out of model context
const PAUSED = "Bot messaging limit reached. Send a message to reset it.";
const UNAVAILABLE = "Bot messaging paused. Send a message to reset it.";
const notice = (id: string, name: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", tool: { name } });

const bot = (messages: Message[]): Bot => ({
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: false,
  color: "blue", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, hasMore: false,
});

const thread: Message[] = [
  { id: "u1", at: 1, role: "user", kind: "text", text: "Have Nova check the release notes." },
  { id: "b1", at: 2, role: "bot", kind: "text", text: "Nova found three gaps." },
  notice("n1", PAUSED, 3),
];

async function mount(messages: Message[], channel = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const group: Group = { id: "channel", threadId: "channel-thread", name: "Channel", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, messages };
  const view = channel ? createElement(Transcript, {
    group, members: [], messages, transcript: messages, streamingMessage: null, dock: null,
    onReply: () => undefined, onMessageMenu: () => undefined, workers: [],
  }) : createElement(ChatView, { bot: bot(messages) });
  await act(async () => root.render(createElement(StoreProvider, null, view)));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

/** The smallest element holding the line, and the row around it. */
function line(host: HTMLElement, text: string) {
  const el = [...host.querySelectorAll("*")].find((node) => node.textContent === text && ![...node.children].some((child) => child.textContent === text));
  return { el, row: el?.closest(".flex.justify-start, .term-notice, .term-step") ?? el?.parentElement ?? null };
}

afterEach(() => {
  delete document.documentElement.dataset.skin;
  applyLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView bots-paused notices", () => {
  const sentenceCases = ["github-dimmed", "terminal"].flatMap((skin) =>
    (["en", "ko"] as const).flatMap((locale) =>
      [false, true].flatMap((channel) => [PAUSED, UNAVAILABLE].map((name) => ({ skin, locale, channel, name }))),
    ),
  );

  it.each(sentenceCases)("keeps each notice sentence unbroken ($skin, $locale, channel=$channel, $name)", async ({ skin, locale, channel, name }) => {
    document.documentElement.dataset.skin = skin;
    applyLocale(locale);
    const view = await mount([notice("n1", name, 1)], channel);
    try {
      const sentences = [...view.host.querySelectorAll(".inline-block.whitespace-nowrap")].filter((el) => el.textContent?.endsWith("."));
      expect(sentences.map((el) => el.textContent)).toEqual(locale === "en" ? name.split(/(?<=\.) /) : [
        name === PAUSED ? "봇 메시지 한도에 도달했어요." : "봇 메시지가 일시 중지됐어요.",
        "메시지를 보내면 한도가 초기화돼요.",
      ]);
      expect(sentences[0]?.parentElement?.textContent).toBe(sentences.map((el) => el.textContent).join(" "));
    } finally {
      await view.unmount();
    }
  });

  const cases = [
    { skin: "github-dimmed", locale: "en", text: PAUSED },
    { skin: "github-dimmed", locale: "ko", text: "봇 메시지 한도에 도달했어요. 메시지를 보내면 한도가 초기화돼요." },
    { skin: "terminal", locale: "en", text: PAUSED },
    { skin: "terminal", locale: "ko", text: "봇 메시지 한도에 도달했어요. 메시지를 보내면 한도가 초기화돼요." },
  ] as const;

  it.each(cases)("draws the real row as a finished plain line ($skin, $locale)", async ({ skin, locale, text }) => {
    document.documentElement.dataset.skin = skin;
    applyLocale(locale);
    const view = await mount(thread);
    try {
      const { el, row } = line(view.host, text);
      expect(el).toBeTruthy();
      expect(row!.querySelector(".animate-spin")).toBeNull();
      expect(row!.textContent).not.toMatch(/Running|실행 중/);
      expect(row!.querySelector("[data-term-step]")).toBeNull();
      expect(row!.closest("[data-term-step]")).toBeNull();
      // a long line wraps at phone width instead of cutting off
      expect(el!.className).not.toMatch(/\btruncate\b/);
      if (skin === "terminal") expect(row!.getAttribute("data-term-notice")).toBe("ok");
    } finally {
      await view.unmount();
    }
  });

  it("draws the unavailable line the same way", async () => {
    document.documentElement.dataset.skin = "terminal";
    const view = await mount([...thread.slice(0, 2), notice("n2", UNAVAILABLE, 3)]);
    try {
      const { row } = line(view.host, UNAVAILABLE);
      expect(row!.getAttribute("data-term-notice")).toBe("ok");
      expect(row!.textContent).toBe(UNAVAILABLE);
    } finally {
      await view.unmount();
    }
  });
});
