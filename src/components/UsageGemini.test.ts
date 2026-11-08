// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsageBoard } from "@/lib/usage-board";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";

const h = vi.hoisted(() => ({ board: null as UsageBoard | null }));
vi.mock("@/state/store", () => ({
  api: vi.fn(async () => ({})),
  useStore: () => ({ state: { instances: [], bots: [], terminalPanes: {} }, dispatch: vi.fn(), refreshInstances: async () => {} }),
}));
vi.mock("@/lib/use-usage-board", () => ({ useUsageBoard: () => ({ board: h.board, status: "ready", pending: {}, failed: new Set() }) }));
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { UsageDesk } from "./UsageDesk";
import { ChatPlanMeters } from "./ChatPlanMeters";

let host: HTMLDivElement;
let root: Root;
const render = async (node = createElement(UsageDesk)) => {
  await act(async () => root.render(createElement(I18nProvider, null, node)));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ now: usageBoardNow });
  localStorage.clear();
  h.board = structuredClone(usageBoardFixture);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["en", "ko"] as const)("hides Gemini everywhere without quota windows in %s", async (locale) => {
  persistPreference(locale);
  const gemini = h.board!.engines.find((engine) => engine.engine === "gemini")!;
  gemini.accounts.forEach((account) => { account.windows = []; });
  await render();
  expect(host.querySelector('[data-usage-engine="gemini"]')).toBeNull();
  expect(host.textContent).not.toMatch(/Gemini|한도를 읽지|can't read/);
  await act(async () => localStorage.setItem("openmausbot.usageFolds.v1", JSON.stringify({ gemini: true })));
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(host.querySelector('[data-usage-engine="gemini"]')).toBeNull();
  await act(async () => root.render(createElement(I18nProvider, null, createElement(ChatPlanMeters, {
    windows: [], driverKind: "antigravityAgent", instanceId: "gemini", now: usageBoardNow, onOpenUsage: () => {},
  }))));
  expect(host.querySelector("[data-usage-meter], [data-usage-quick]")).toBeNull();
});

it.each(["en", "ko"] as const)("shows real Gemini quota bars in rows and folded headers in %s", async (locale) => {
  persistPreference(locale);
  await render();
  const section = host.querySelector('[data-usage-engine="gemini"]')!;
  expect(section).not.toBeNull();
  expect(section.querySelectorAll("[data-cells]")).toHaveLength(1);
  expect(section.querySelector("[data-left]")?.textContent).toContain("82%");
  await act(async () => section.querySelector<HTMLButtonElement>("[data-engine-fold]")!.click());
  expect(section.querySelectorAll("[data-engine-summary] [data-cells]")).toHaveLength(1);
  expect(section.querySelector("[data-engine-summary] [data-left]")?.textContent).toContain("82%");
});

it("keeps an unread Gemini account hidden when another account has quota", async () => {
  const gemini = h.board!.engines.find((engine) => engine.engine === "gemini")!;
  gemini.accounts.push({ ...gemini.accounts[0]!, id: "gemini-plan", main: false });
  gemini.accounts[0]!.windows = [];
  await render();
  expect(host.querySelector('[data-account-row="gemini"]')).toBeNull();
  expect(host.querySelector('[data-account-row="gemini-plan"] [data-cells]')).not.toBeNull();
});
