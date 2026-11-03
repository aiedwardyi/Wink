// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistPreference, I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import type { UsageAccount } from "@/lib/accounts";

const { state, request, refreshInstances } = vi.hoisted(() => ({
  state: { bots: [{ id: "bot", modelSelection: { instanceId: "claude" }, tasks: [] }], instances: [] as InstanceInfo[] },
  request: vi.fn(),
  refreshInstances: vi.fn(async () => {}),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: request,
  useStore: () => ({ state, dispatch: vi.fn(), refreshInstances }),
}));
import { UsageSection } from "./UsageSection";

let root: Root;
let host: HTMLDivElement;
const engine = (id: string, used = 20, signedIn = true): UsageAccount => ({
  instanceId: id, driverKind: "claudeAgent", displayName: "Claude",
  accountOf: "claude", accountState: "ready", accountMain: id === "claude",
  snapshot: { state: "available", authenticated: signedIn, account: `${id}@example.com` },
  models: { default: "opus", options: [] },
  capabilities: { rateLimits: true },
  canRefreshUsage: true,
  rateLimits: { observedAt: new Date().toISOString(), windows: [{ id: "five_hour", usedPercent: used, resetsAt: Date.now() + 3_600_000 }] },
});
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name)!;
const main = () => host.querySelector('[data-account-column="main"]')!;
const other = () => host.querySelector('[data-account-column="other"] > div:not([inert])')!;
async function render(count = 2) {
  state.instances = [engine("claude"), engine("second", 70), engine("third", 95)].slice(0, count);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
}
beforeEach(() => {
  persistPreference("en");
  state.bots.splice(1);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  refreshInstances.mockImplementation(async () => { root.render(createElement(I18nProvider, null, createElement(UsageSection))); });
  request.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/accounts") return { accounts: state.instances.map((account) => ({
      id: account.instanceId, of: account.accountOf, state: account.accountState, default: account.accountMain,
    })) };
    if (path.endsWith("/default")) {
      state.instances = state.instances.map((account) => ({ ...account, accountMain: path.includes(`/${account.instanceId}/`) }));
    }
    return {};
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("keeps the single-account row unchanged without account controls", async () => {
  await render(1);
  expect(host.textContent).toContain("Claude");
  expect(host.querySelector('[data-account-column]')).toBeNull();
  expect(button("Set as Main")).toBeUndefined();
  expect(host.querySelector('[aria-label="Next Account"]')).toBeNull();
  expect(host.textContent).not.toContain("@example.com");
});

it("groups pushed accounts immediately and after returning without a side fetch", async () => {
  request.mockImplementation(() => new Promise(() => {}));
  await render();
  expect(host.querySelectorAll('[data-account-column="main"]')).toHaveLength(1);
  expect(other().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
  expect(host.querySelectorAll('[data-account-column="main"]')).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
});

it("puts icon headings and Main above the matching account's bars without email text", async () => {
  await render();
  expect(main().querySelector('[aria-label="5h: 80% remaining"]')).not.toBeNull();
  expect(other().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  expect(main().textContent).not.toContain("Set as Main");
  expect(other().textContent).toContain("Set as Main");
  expect(main().textContent).toContain("ClaudeMain");
  expect(host.textContent).not.toContain("@example.com");
  expect(other().textContent).not.toContain("MainSet");
  expect(request).not.toHaveBeenCalledWith("/api/accounts");
  expect(host.querySelector('[aria-label="Next Account"]')).toBeNull();
});

it("uses the pushed Main flag even when the base account arrives first", async () => {
  await render();
  state.instances = state.instances.map((account) => ({ ...account, accountMain: account.instanceId === "second" }));
  await act(async () => root.render(createElement(UsageSection)));
  expect(main().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
});

it("Set as Main posts once and moves that account left without confirmation", async () => {
  await render();
  await act(async () => button("Set as Main").click());
  expect(request).toHaveBeenCalledWith("/api/accounts/second/default", { method: "POST", body: "{}" });
  expect(main().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => button("Set as Main").click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/default", { method: "POST", body: "{}" });
  expect(main().querySelector('[aria-label="5h: 80% remaining"]')).not.toBeNull();
});

it("pages three accounts and keeps hidden pages in the same grid cell", async () => {
  await render(3);
  expect(other().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Next Account"]:not([disabled])')!.click());
  expect(other().querySelector('[aria-label="5h: 5% remaining"]')).not.toBeNull();
  expect(host.querySelectorAll('[data-account-column="other"] > div[inert]')).toHaveLength(1);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Previous Account"]:not([disabled])')!.click());
  expect(other().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
});

it("shows the account's email only in the icon's card", async () => {
  await render();
  expect(document.querySelector('[data-engine-card]')).toBeNull();
  const mark = other().querySelector<HTMLElement>('[data-engine-hover]')!;
  await act(async () => {
    mark.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
    mark.click();
  });
  expect(document.querySelector('[data-engine-card]')?.textContent).toContain("second@example.com");
  expect(other().textContent).not.toContain("second@example.com");
  await act(async () => {
    mark.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
    mark.click();
  });
  expect(document.querySelector('[data-engine-card]:not([data-closing])')).toBeNull();
});

it("reveals the account on icon hover", async () => {
  await render();
  vi.useFakeTimers();
  const mark = other().querySelector('[data-engine-hover]')!;
  await act(async () => {
    mark.dispatchEvent(new window.PointerEvent("pointerover", { pointerType: "mouse", bubbles: true }));
    vi.advanceTimersByTime(600);
  });
  expect(document.querySelector('[data-engine-card]')?.textContent).toContain("second@example.com");
});

it("shows signed out without bars or Set as Main", async () => {
  await render();
  state.instances = [state.instances[0]!, engine("second", 70, false)];
  await act(async () => root.render(createElement(UsageSection)));
  expect(other().textContent).toContain("Signed out.");
  expect(other().textContent).not.toContain("Set as Main");
  expect(other().querySelector('[aria-label*="remaining"]')).toBeNull();
});

it("keeps a signed-out default left without falling back", async () => {
  await render();
  state.instances = [engine("claude", 20, false), state.instances[1]!];
  await act(async () => root.render(createElement(UsageSection)));
  expect(main().textContent).toContain("Signed out.");
  expect(other().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/default"))).toBe(false);
});

it("does not switch a default whose limit is hit", async () => {
  await render();
  request.mockImplementation(async () => ({ status: "limit_reached", resetsAt: Date.now() + 3_600_000 }));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Alt+R"]')!.click());
  expect(main().textContent).toContain("Limit reached.");
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/default"))).toBe(false);
  expect(request.mock.calls.some(([path]) => path === "/api/usage/refresh/second")).toBe(true);
});

it("keeps the default in place and shows failure if the API rejects a pick", async () => {
  await render();
  request.mockRejectedValueOnce(new Error(""));
  await act(async () => button("Set as Main").click());
  expect(main().querySelector('[aria-label="5h: 80% remaining"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Didn't finish");
});

it("translates account controls into Korean", async () => {
  persistPreference("ko");
  await render(3);
  expect(button("기본으로 설정")).toBeDefined();
  expect(main().textContent).toContain("Claude기본");
  expect(host.querySelector('[aria-label="다음 계정"]')).not.toBeNull();
});

it.each(["en", "ko"] as const)("shows default refusal messages in %s", async (locale) => {
  persistPreference(locale);
  await render();
  request.mockRejectedValueOnce(new Error("This account is still used by a pane"));
  await act(async () => button(locale === "en" ? "Set as Main" : "기본으로 설정").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("This account is still used by a pane");
});

it.each([false, true])("uses server refresh eligibility instead of account ids (%s)", async (allowed) => {
  const id = allowed ? "acct_legacy" : "claude";
  state.instances = [{ ...engine(id), canRefreshUsage: allowed } as UsageAccount];
  await act(async () => root.render(createElement(UsageSection)));
  request.mockClear();
  const refresh = host.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Alt+R"]');
  if (refresh) await act(async () => refresh.click());
  expect(request.mock.calls.some(([path]) => path === `/api/usage/refresh/${id}`)).toBe(allowed);
});
