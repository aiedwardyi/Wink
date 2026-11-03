// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistPreference, I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

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
import { EnginesSettings } from "./EnginesSettings";

let root: Root;
let host: HTMLDivElement;
let accounts: { id: string; of: string; state: string; default?: boolean }[];
const engine = (id: string, used = 20, signedIn = true): InstanceInfo => ({
  instanceId: id, driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: signedIn, account: `${id}@example.com` },
  models: { default: "opus", options: [] },
  capabilities: { rateLimits: true },
  rateLimits: { observedAt: new Date().toISOString(), windows: [{ id: "five_hour", usedPercent: used, resetsAt: Date.now() + 3_600_000 }] },
});
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === name)!;
const main = () => host.querySelector('[data-account-column="main"]')!;
const other = () => host.querySelector('[data-account-column="other"] > div:not([inert])')!;
async function render(count = 2, component = UsageSection) {
  state.instances = [engine("claude"), engine("second", 70), engine("third", 95)].slice(0, count);
  accounts = state.instances.map((instance) => ({ id: instance.instanceId, of: "claude", state: "ready", default: instance.instanceId === "claude" }));
  await act(async () => root.render(createElement(I18nProvider, null, createElement(component))));
}
beforeEach(() => {
  persistPreference("en");
  state.bots.splice(1);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  request.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/accounts") return { accounts };
    if (path.endsWith("/default")) {
      accounts = accounts.map((account) => ({ ...account, default: path.includes(`/${account.id}/`) }));
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
  expect(button("Use for Bots")).toBeUndefined();
  expect(host.querySelector('[aria-label="Next Account"]')).toBeNull();
  expect(host.textContent).not.toContain("@example.com");
});

it("puts the default left and the other account right with no email text", async () => {
  await render();
  expect(main().querySelector('[aria-label="5h: 80% remaining"]')).not.toBeNull();
  expect(other().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  expect(main().textContent).not.toContain("Use for Bots");
  expect(other().textContent).toContain("Use for Bots");
  expect(host.textContent).not.toContain("@example.com");
  expect(host.querySelector('[aria-label="Next Account"]')).toBeNull();
});

it("uses the API default flag even when the base account arrives first", async () => {
  await render();
  accounts = accounts.map((account) => ({ ...account, default: account.id === "second" }));
  state.instances = [...state.instances];
  await act(async () => root.render(createElement(UsageSection)));
  expect(main().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
});

it("Use for Bots posts once and moves that account left without confirmation", async () => {
  await render();
  await act(async () => button("Use for Bots").click());
  expect(request).toHaveBeenCalledWith("/api/accounts/second/default", { method: "POST", body: "{}" });
  expect(main().querySelector('[aria-label="5h: 30% remaining"]')).not.toBeNull();
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => button("Use for Bots").click());
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

it("reveals an email only through its icon and closes on another tap", async () => {
  await render();
  expect(document.querySelector('[data-engine-card]')).toBeNull();
  const mark = other().querySelector<HTMLElement>('[data-engine-hover]')!;
  await act(async () => {
    mark.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
    mark.click();
  });
  expect(document.querySelector('[data-engine-card]')?.textContent).toContain("second@example.com");
  expect(host.textContent).not.toContain("second@example.com");
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

it("shows signed out without bars or Use for Bots", async () => {
  await render();
  state.instances = [state.instances[0]!, engine("second", 70, false)];
  await act(async () => root.render(createElement(UsageSection)));
  expect(other().textContent).toContain("Signed out.");
  expect(other().textContent).not.toContain("Use for Bots");
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
  request.mockImplementation(async (path: string) => path === "/api/accounts" ? { accounts }
    : { status: "limit_reached", resetsAt: Date.now() + 3_600_000 });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-keyshortcuts="Alt+R"]')!.click());
  expect(main().textContent).toContain("Limit reached.");
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/default"))).toBe(false);
  expect(request.mock.calls.some(([path]) => path === "/api/usage/refresh/second")).toBe(false);
});

it("keeps the default in place and shows failure if the API rejects a pick", async () => {
  await render();
  request.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Use for Bots").click());
  expect(main().querySelector('[aria-label="5h: 80% remaining"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Didn't finish");
});

it("translates account controls into Korean", async () => {
  persistPreference("ko");
  await render(3);
  expect(button("봇에 사용")).toBeDefined();
  expect(host.querySelector('[aria-label="다음 계정"]')).not.toBeNull();
});

it("requires two taps to sign out and sends the selected destination", async () => {
  await render(3, EnginesSettings);
  await act(async () => button("Sign Out").click());
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/sign-out"))).toBe(false);
  expect(host.textContent).toContain("1 bot uses this account.");
  const choices = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect([...choices].map((choice) => choice.getAttribute("aria-label"))).toEqual(["second@example.com", "third@example.com"]);
  expect([...choices].map((choice) => choice.closest("label")?.textContent)).toEqual(["second@example.com", "third@example.com"]);
  await act(async () => choices[1]!.click());
  await act(async () => button("Move and Sign Out").click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: JSON.stringify({ destinationId: "third" }) });
});

it("names connected accounts and keeps full labels available when truncated", async () => {
  await render(2, EnginesSettings);
  const label = "personal.account.with.a.very.long.address@example.com";
  state.instances = [state.instances[0]!, { ...state.instances[1]!, snapshot: { ...state.instances[1]!.snapshot, account: label } }];
  await act(async () => root.render(createElement(EnginesSettings)));
  expect(host.textContent).toContain("claude@example.com");
  expect(host.textContent).toContain(label);
  expect(host.textContent).not.toContain("Connected");
  const identity = host.querySelector<HTMLElement>(`span[title="${label}"]`)!;
  expect(identity.textContent).toBe(label);
  expect(identity.classList.contains("truncate")).toBe(true);
});

it.each(["Personal account", undefined])("uses the engine account label when no email is available (%s)", async (label) => {
  await render(2, EnginesSettings);
  state.instances = [state.instances[0]!, { ...state.instances[1]!, snapshot: { ...state.instances[1]!.snapshot, account: label } }];
  await act(async () => root.render(createElement(EnginesSettings)));
  expect(host.querySelector(`span[title="${label ?? "Claude"}"]`)?.textContent).toBe(label ?? "Claude");
});

it.each(["en", "ko"] as const)("names the only ready destination without radios in %s", async (locale) => {
  persistPreference(locale);
  state.bots.push({ ...state.bots[0]!, id: "second-bot" });
  await render(2, EnginesSettings);
  await act(async () => button(locale === "en" ? "Sign Out" : "로그아웃").click());
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(host.querySelector('input[type="radio"]')).toBeNull();
  expect(host.textContent).toContain(locale === "en"
    ? "2 bots use this account. They move to second@example.com."
    : "봇 2개가 이 계정을 써요. second@example.com 계정으로 옮겨져요.");
  await act(async () => button(locale === "en" ? "Move and Sign Out" : "옮기고 로그아웃").click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: JSON.stringify({ destinationId: "second" }) });
});

it("excludes signed-out accounts when choosing the only ready destination", async () => {
  await render(3, EnginesSettings);
  state.instances = [state.instances[0]!, state.instances[1]!, engine("third", 95, false)];
  await act(async () => root.render(createElement(EnginesSettings)));
  expect(host.textContent).toContain("Signed out.");
  await act(async () => button("Sign Out").click());
  expect(host.querySelector('input[type="radio"]')).toBeNull();
  expect(host.textContent).toContain("1 bot uses this account. It moves to second@example.com.");
});

it("names both radio destinations in Korean", async () => {
  persistPreference("ko");
  await render(3, EnginesSettings);
  await act(async () => button("로그아웃").click());
  const choices = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect([...choices].map((choice) => choice.closest("label")?.textContent)).toEqual(["second@example.com", "third@example.com"]);
  expect(host.textContent).toContain("옮길 계정");
});

it("cancels removal without sending a sign-out", async () => {
  await render(2, EnginesSettings);
  await act(async () => button("Sign Out").click());
  await act(async () => button("Cancel").click());
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/sign-out"))).toBe(false);
});

it("blocks removing the default when no signed-in destination exists", async () => {
  await render(2, EnginesSettings);
  state.instances = [state.instances[0]!, engine("second", 70, false)];
  await act(async () => root.render(createElement(EnginesSettings)));
  await act(async () => button("Sign Out").click());
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(button("Sign Out").disabled).toBe(true);
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/sign-out"))).toBe(false);
});
