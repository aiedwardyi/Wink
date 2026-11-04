// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
  state.instances = [engine("claude"), engine("second", 70), engine("third", 95), engine("fourth", 45)].slice(0, count);
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

it("dims only the non-Main account's bars and shows Set as Main as a button", async () => {
  await render();
  expect(main().querySelector('[aria-label="5h: 80% remaining"] span[aria-hidden="true"]')!.classList).not.toContain("opacity-45");
  expect(other().querySelector('[aria-label="5h: 30% remaining"] span[aria-hidden="true"]')!.classList).toContain("opacity-45");
  expect(other().querySelector("button:not([aria-label])")?.textContent).toBe("Set as Main");
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

it("pages one account at a time on phone, starting with Main", async () => {
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  onTestFinished(() => media.mockRestore());
  await render(3);
  const shown = () => host.querySelector('[data-account-column="pages"] > div:not([inert])')!;
  const next = () => shown().querySelector<HTMLButtonElement>('[aria-label="Next Account"]')!;
  expect(host.querySelector('[data-account-column="main"]')).toBeNull();
  expect(host.querySelectorAll('[data-account-column="pages"] > div[inert]')).toHaveLength(2);
  expect(shown().textContent).toContain("claude@example.comMain");
  expect(shown().querySelector('[aria-label="5h: 80% remaining"]')).not.toBeNull();
  expect(shown().querySelector<HTMLButtonElement>('[aria-label="Previous Account"]')!.disabled).toBe(true);
  await act(async () => next().click());
  expect(shown().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  expect(shown().textContent).toContain("Set as Main");
  await act(async () => next().click());
  expect(shown().querySelector('[aria-label="5h: 5% remaining"]')).not.toBeNull();
  expect(next().disabled).toBe(true);
  await act(async () => shown().querySelector<HTMLButtonElement>("button:not([aria-label])")!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/third/default", { method: "POST", body: "{}" });
  expect(shown().querySelector('[aria-label="5h: 5% remaining"]')).not.toBeNull();
  expect(shown().textContent).toContain("third@example.comMain");
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

it("keeps Main and Set as Main in the same head action slot with or without paging", async () => {
  for (const count of [2, 3]) {
    await render(count);
    const pick = button("Set as Main");
    const tag = [...main().querySelectorAll("span")].find((node) => !node.children.length && node.textContent === "Main")!;
    expect(tag.parentElement?.className).toBe(pick.parentElement?.className);
    expect(tag.nextElementSibling).not.toBeNull();
    expect(pick.nextElementSibling).not.toBeNull();
    expect(tag.nextElementSibling?.className).toBe(pick.nextElementSibling?.className);
    expect(pick.nextElementSibling?.querySelectorAll("button")).toHaveLength(count === 3 ? 2 : 0);
  }
});

it.each([1, 2])("keeps a 5h placeholder above weekly-only Claude usage for %i accounts", async (count) => {
  await render(count);
  state.instances = state.instances.map((account) => ({ ...account,
    rateLimits: { observedAt: new Date().toISOString(), windows: [{ id: "seven_day", usedPercent: 37, resetsAt: null }] },
  }));
  await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
  expect(host.querySelectorAll('[aria-label="7d: 63% remaining"]')).toHaveLength(count);
  expect(host.textContent?.match(/5h–/g)).toHaveLength(count);
  expect(host.querySelector('[aria-label^="5h:"]')).toBeNull();
  const weekly = host.querySelector('[aria-label="7d: 63% remaining"]')!;
  expect(weekly.parentElement?.previousElementSibling?.textContent).toBe("5h–");
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

const shown = () => host.querySelector('[data-account-column="pages"] > div:not([inert]), [data-account-column="other"] > div:not([inert])')!;
const picker = () => shown().querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
const rerender = () => act(async () => root.render(createElement(I18nProvider, null, createElement(UsageSection))));
function phoneView(phone = true) {
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  onTestFinished(() => media.mockRestore());
}
async function jump(id: string) {
  await act(async () => picker().click());
  await act(async () => items().find((node) => node.textContent?.includes(`${id}@example.com`))!.click());
}

it.each([false, true])("offers pickers only for multiple pages on phone=%s", async (phone) => {
  phoneView(phone);
  for (const count of [1, 2, 4]) {
    await render(count);
    expect(host.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(count > (phone ? 1 : 2) ? (phone ? count : count - 1) : 0);
    if (count > (phone ? 1 : 2)) {
      await act(async () => picker().click());
      expect(items().map((node) => node.textContent)).toEqual((phone ? ["claude@example.comMain"] : []).concat(["second@example.com", "third@example.com", "fourth@example.com"].slice(0, count - 1)));
      await act(async () => items()[0]!.click());
    }
  }
});

it.each([false, true])("jumps directly to account four without changing Main on phone=%s", async (phone) => {
  phoneView(phone);
  await render(4);
  await jump("fourth");
  expect(shown().querySelector('[aria-label="5h: 55% remaining"]')).not.toBeNull();
  expect(picker().textContent).toContain("fourth@example.com");
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(picker());
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/default"))).toBe(false);
  await act(async () => shown().querySelector<HTMLButtonElement>('[aria-label="Previous Account"]')!.click());
  expect(picker().textContent).toContain("third@example.com");
});

it.each([false, true])("keeps selection by id across refresh, add, remove and Main changes on phone=%s", async (phone) => {
  phoneView(phone);
  await render(4);
  await jump("fourth");
  state.instances = state.instances.map((account) => ({ ...account }));
  await rerender();
  expect(picker().textContent).toContain("fourth@example.com");
  state.instances = [engine("new", 10), ...state.instances];
  await rerender();
  expect(picker().textContent).toContain("fourth@example.com");
  state.instances = state.instances.map((account) => ({ ...account, accountMain: account.instanceId === "second" }));
  await rerender();
  expect(picker().textContent).toContain("fourth@example.com");
  state.instances = state.instances.filter((account) => account.instanceId !== "fourth");
  await rerender();
  expect(picker().textContent).toContain(phone ? "second@example.com" : "new@example.com");
  state.instances = [...state.instances, engine("fourth", 45)];
  await rerender();
  expect(picker().textContent).toContain(phone ? "second@example.com" : "new@example.com");
});

it.each([false, true])("reconciles the viewed account becoming Main on phone=%s", async (phone) => {
  phoneView(phone);
  await render(4);
  await jump("fourth");
  state.instances = state.instances.map((account) => ({ ...account, accountMain: account.instanceId === "fourth" }));
  await rerender();
  expect(picker().textContent).toContain(phone ? "fourth@example.com" : "claude@example.com");
  await act(async () => picker().click());
  expect(items().map((node) => node.textContent)).toEqual((phone ? ["fourth@example.comMain"] : []).concat(["claude@example.com", "second@example.com", "third@example.com"]));
});

it("supports menu arrow keys, Escape, outside dismissal and focus return", async () => {
  await render(4);
  await act(async () => picker().click());
  expect(document.activeElement).toBe(items()[0]);
  await act(async () => items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement).toBe(items()[1]);
  await act(async () => items()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  expect(document.activeElement).toBe(items()[0]);
  await act(async () => items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(picker());
  await act(async () => picker().click());
  await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(host.querySelector('[role="menu"]')).toBeNull();
});

it.each(["en", "ko"] as const)("labels missing emails distinctly in %s and keeps signed-out and draining accounts selectable", async (locale) => {
  phoneView();
  persistPreference(locale);
  await render(4);
  state.instances = state.instances.map((account, i) => ({ ...account, snapshot: { ...account.snapshot, account: undefined, authenticated: i !== 2 } }));
  state.instances[3]!.drain = { destinationId: "claude", phase: "failed" };
  await rerender();
  expect(picker().getAttribute("aria-label")).toBe(locale === "en" ? "Choose account: Account 1" : "계정 선택: 계정 1");
  await act(async () => picker().click());
  expect(items().map((node) => node.textContent)).toEqual(locale === "en" ? ["Account 1Main", "Account 2", "Account 3", "Account 4"] : ["계정 1기본", "계정 2", "계정 3", "계정 4"]);
  await act(async () => items()[2]!.click());
  expect(shown().textContent).toContain(locale === "en" ? "Signed out." : "로그아웃됨.");
  await act(async () => picker().click());
  await act(async () => items()[3]!.click());
  expect(shown().querySelector('[aria-label*="remaining"]')).toBeNull();
  expect(shown().textContent).not.toContain(locale === "en" ? "Set as Main" : "기본으로 설정");
});

it("marks the base Main without a pushed Main flag and preserves long emails", async () => {
  phoneView();
  await render(4);
  const email = `${"long".repeat(20)}@example.com`;
  state.instances = state.instances.map((account) => ({ ...account, accountMain: undefined }));
  state.instances[3]!.snapshot.account = email;
  await rerender();
  await act(async () => picker().click());
  expect(items()[0]!.textContent).toBe("claude@example.comMain");
  expect(items()[0]!.getAttribute("aria-checked")).toBe("true");
  expect(items()[3]!.textContent).toBe(email);
  await act(async () => items()[3]!.click());
  expect(picker().textContent).toBe(email);
});
