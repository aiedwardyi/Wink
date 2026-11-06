// @vitest-environment happy-dom
// The plan card these tests once covered is now the usage desk (UsageSection.desk.test.ts pins it).
// What stays here: the section wrapper, the shared meter tone, and the cuts that must not come back.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";
import { usageBoardFixture } from "@/lib/usage-board.fixture";
import type { InstanceInfo } from "@/state/store";

const { mockState, mockApi } = vi.hoisted(() => ({
  mockState: {
    bots: [{
      id: "bot-1",
      hidden: false,
      name: "Friend",
      modelSelection: { instanceId: "grok", model: "grok-4.6" },
      tasks: [{ threadId: "t", title: "", createdAt: 0, usage: { input: 10, output: 4, costUsd: 0.01, turns: 2 } }],
    }],
    instances: [] as InstanceInfo[],
    terminalPanes: {},
  },
  mockApi: vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({})),
}));

vi.mock("@/lib/usage-auto-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/usage-auto-refresh")>()),
  useAutoRefresh: () => undefined,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: (path: string, init?: RequestInit) => mockApi(path, init),
  useStore: () => ({ state: mockState, dispatch: () => undefined }),
}));

import { UsageSection } from "./UsageSection";
import { ChatPlanMeters } from "./ChatPlanMeters";

async function mounted(run: (host: HTMLDivElement) => Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
    await act(async () => { await Promise.resolve(); });
    await run(host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

describe("UsageSection", () => {
  afterEach(() => {
    mockApi.mockReset();
    mockApi.mockImplementation(async () => ({}));
    persistPreference("en");
    vi.useRealTimers();
  });

  it("shows the desk and hides the per-bot table", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(UsageSection)));
    expect(html).toContain("data-usage-desk");
    expect(html).not.toContain(">Turns<");
    expect(html).not.toContain(">Tokens<");
    expect(html).not.toContain(">Cost<");
    expect(html).not.toContain("Friend");
  });

  it("never shows a token readout in settings or the chat strip", async () => {
    mockApi.mockImplementation(async (path) => path.startsWith("/api/usage/board") ? structuredClone(usageBoardFixture) : {});
    await mounted(async (host) => {
      expect(host.querySelector("[data-account-bars]")).not.toBeNull();
      expect(host.querySelector("[data-usage-hero]")).toBeNull();
      expect(host.textContent).not.toContain("↑");
      expect(host.textContent).not.toContain("↓");
    });
    const chat = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(ChatPlanMeters, { windows: [{ id: "five_hour", usedPercent: 10, resetsAt: Date.now() + 3_600_000 }], onOpenUsage: () => {} })));
    expect(chat).not.toContain("↑");
    expect(chat).not.toContain("↓");
  });

  it("shows no Check now, Refresh or Used/Remaining control in English or Korean", async () => {
    mockApi.mockImplementation(async (path) => path.startsWith("/api/usage/board") ? structuredClone(usageBoardFixture) : {});
    for (const [locale, words] of [["en", ["Check now", "Checking", "Refresh", "Used", "Remaining"]], ["ko", ["지금 확인", "확인 중", "새로 고침", "사용함", "남음"]]] as const) {
      persistPreference(locale);
      await mounted(async (host) => {
        const controls = [...host.querySelectorAll("button")].map((button) => `${button.textContent} ${button.getAttribute("aria-label") ?? ""}`);
        for (const word of words) expect(controls.filter((control) => control.includes(word)), `${locale} ${word}`).toEqual([]);
        expect(host.querySelector("[aria-pressed]")).toBeNull();
      });
    }
  });

  it("never checks Muse or refreshes on open, on a timer or on Alt+R", async () => {
    vi.useFakeTimers();
    mockApi.mockImplementation(async (path) => path.startsWith("/api/usage/board") ? structuredClone(usageBoardFixture) : {});
    await mounted(async () => {
      const opened = mockApi.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", altKey: true, bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "®", altKey: true, bubbles: true }));
      });
      await act(async () => { await Promise.resolve(); });
      const paths = mockApi.mock.calls.map(([path]) => path);
      expect(paths.filter((path) => /^\/api\/usage\/(check|refresh)\//.test(path))).toEqual([]);
      expect(paths.slice(opened)).toEqual([]);
    });
  });
});
