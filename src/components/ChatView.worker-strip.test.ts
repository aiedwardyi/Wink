// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { StoreProvider, type Bot, type Message } from "@/state/store";
import { ChatView, clearLivePaneCache } from "./ChatView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const launch = (i: number): Message => ({ id: `launch-${i}`, at: i + 1, role: "bot", kind: "launch", text: `Launched W${i} | Opus 5.5 | high\nSession: ${i}0000000-1` });
const blocked: Message = { id: "blocked", at: 20, role: "bot", kind: "note", text: "[pane 00000000] [W0 | Opus 5.5 | high] from Ada (ada): BLOCKED W0 branch=x sha=y dirty=no" };

const bot = (workers: number): Bot => ({
  id: "ada", threadId: "thread-ada", name: "Ada", title: "", description: "", notifications: false, color: "iris", unread: false,
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [{ id: "u", at: 0, role: "user", kind: "text", text: "go" }, ...Array.from({ length: workers }, (_, i) => launch(i)), ...(workers ? [blocked] : [])],
} as unknown as Bot);

async function mount(workers: number, phone: boolean) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: bot(workers) }))));
  const header = host.querySelector<HTMLElement>("[class*='@container/chathead']")!;
  return { header, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

afterEach(() => {
  applyLocale("en");
  clearLivePaneCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("chat header worker badge", () => {
  it.each([false, true])("marks one waiting worker with a dot and no count with phone=%s", async (phone) => {
    const { header, unmount } = await mount(1, phone);
    try {
      expect(header.querySelector("[data-worker-strip]")).toBeNull();
      const button = header.querySelector("[data-show-pane-button]")!;
      const badge = button.querySelector("[data-worker-badge]")!;
      expect(badge.textContent).toBe("");
      expect(badge.getAttribute("data-worker-state")).toBe("waiting");
      expect(badge.classList.contains("bg-warning")).toBe(true);
      expect(button.getAttribute("title")).toBe("Show and media");
      expect(button.getAttribute("aria-label")).toBe("0 working, 1 waiting, 0 failed, 0 done. Show workers");
      expect(header.querySelector("[data-worker-status]")).toBeNull();
    } finally { await unmount(); }
  });

  it.each([false, true])("counts six working on the badge in the waiting color with phone=%s", async (phone) => {
    const { header, unmount } = await mount(7, phone);
    try {
      expect(header.querySelector("[data-worker-strip]")).toBeNull();
      const button = header.querySelector("[data-show-pane-button]")!;
      expect(button.querySelector("[data-worker-badge]")?.textContent).toBe("6");
      expect(button.querySelector("[data-worker-badge]")?.classList.contains("bg-warning")).toBe(true);
      expect(button.getAttribute("aria-label")).toBe("6 working, 1 waiting, 0 failed, 0 done. Show workers");
    } finally { await unmount(); }
  });

  it("has no badge and no worker line without workers", async () => {
    const { header, unmount } = await mount(0, false);
    try {
      expect(header.querySelector("[data-worker-badge]")).toBeNull();
      expect(header.querySelector("[data-show-pane-button]")?.getAttribute("aria-label")).toBe("Show and media");
      expect(header.querySelector("[data-worker-status]")).toBeNull();
    } finally { await unmount(); }
  });

  it("labels the badge in Korean", async () => {
    applyLocale("ko");
    const { header, unmount } = await mount(7, false);
    try {
      expect(header.querySelector("[data-show-pane-button]")?.getAttribute("aria-label")).toBe("작업 중 6개, 대기 중 1개, 실패 0개, 완료 0개. 작업자 보기");
    } finally { await unmount(); }
  });
});
