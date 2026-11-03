// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistPreference, I18nProvider } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const { state, request, refreshInstances } = vi.hoisted(() => ({
  state: { bots: [{ modelSelection: { instanceId: "claude" } }, { modelSelection: { instanceId: "claude" } }], instances: [] as InstanceInfo[] },
  request: vi.fn(),
  refreshInstances: vi.fn(async () => {}),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: request,
  useStore: () => ({ state, dispatch: vi.fn(), refreshInstances }),
}));
import { EnginesSettings } from "./EnginesSettings";

let root: Root;
let host: HTMLDivElement;
let accounts: { id: string; of: string; state: string; default?: boolean }[];
const engine = (id: string, signedIn = true): InstanceInfo => ({
  instanceId: id, driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: signedIn, account: `${id}@example.com` },
  models: { default: "opus", options: [] },
  install: { login: { args: ["login"], deviceArgs: ["login", "--device"] } },
});
const buttons = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.textContent === name);
async function render(count = 2) {
  state.instances = Array.from({ length: count }, (_, i) => engine(i ? `account-${i}` : "claude"));
  accounts = state.instances.map((instance) => ({ id: instance.instanceId, of: "claude", state: "ready", default: instance.instanceId === "claude" }));
  await update();
}
async function update() {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(EnginesSettings))));
}
beforeEach(() => {
  persistPreference("en");
  vi.stubGlobal("ogb", undefined);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  refreshInstances.mockClear();
  request.mockReset().mockImplementation(async (path: string) => path === "/api/accounts" ? { accounts } : {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["en", "ko"] as const)("signs out in one tap with no move choices or bot count in %s", async (locale) => {
  persistPreference(locale);
  await render(3);
  const name = locale === "en" ? "Sign Out" : "로그아웃";
  expect(buttons(name)).toHaveLength(3);
  await act(async () => buttons(name)[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: "{}" });
  expect(request.mock.calls.filter(([path]) => String(path).endsWith("/sign-out"))).toHaveLength(1);
  expect(host.querySelector('input, [role="radiogroup"]')).toBeNull();
  expect(host.textContent).not.toMatch(/Move|bots? use|옮|봇/);
});

it("signs out the main account even when no other account is ready", async () => {
  await render();
  state.instances[1] = engine("account-1", false);
  await update();
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: "{}" });
  expect(host.textContent).toContain("Signed out.");
  expect(buttons("Sign In")).toHaveLength(1);
});

it("names connected accounts and keeps the full truncated label available", async () => {
  await render();
  const label = "personal.account.with.a.very.long.address@example.com";
  state.instances[1]!.snapshot.account = label;
  await update();
  expect(host.textContent).toContain("claude@example.com");
  const identity = host.querySelector<HTMLElement>(`span[title="${label}"]`)!;
  expect(identity.textContent).toBe(label);
  expect(identity.classList.contains("truncate")).toBe(true);
  expect(buttons("Sign Out")).toHaveLength(2);
});

it.each(["Personal account", undefined])("uses the engine account label without an email (%s)", async (label) => {
  await render(1);
  state.instances[0]!.snapshot.account = label;
  await update();
  expect(host.querySelector(`span[title="${label ?? "Claude"}"]`)?.textContent).toBe(label ?? "Claude");
});

it.each(["en", "ko"] as const)("offers one Add Account per engine, including a single account, in %s", async (locale) => {
  persistPreference(locale);
  await render(1);
  state.instances = [...state.instances, { ...engine("codex"), driverKind: "codex", displayName: "Codex" }];
  accounts.push({ id: "codex", of: "codex", state: "ready", default: true });
  await update();
  const add = buttons(locale === "en" ? "Add Account" : "계정 추가");
  expect(add).toHaveLength(2);
  for (const [i, base] of ["claude", "codex"].entries()) {
    await act(async () => add[i]!.click());
    expect(request).toHaveBeenCalledWith("/api/accounts", { method: "POST", body: JSON.stringify({ of: base, device: true }) });
  }
});

it.each([false, true])("opens the existing add/sign-in flow with desktop bridge %s", async (desktop) => {
  if (desktop) vi.stubGlobal("ogb", { platform: "win32" });
  await render();
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/accounts" && init?.method === "POST") {
      state.instances = [...state.instances, { ...engine("new", false), loginState: "pending", loginCapture: { code: "ABCD", url: "https://example.com/login" } }];
      accounts.push({ id: "new", of: "claude", state: "pending" });
      return { id: "new", state: "pending" };
    }
    return path === "/api/accounts" ? { accounts } : {};
  });
  await act(async () => buttons("Add Account")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts", { method: "POST", body: JSON.stringify({ of: "claude", device: !desktop }) });
  await update();
  expect(host.textContent).toContain("ABCD");
  expect(host.querySelector('a[href="https://example.com/login"]')).not.toBeNull();
  expect(buttons("Add Account")).toHaveLength(1);
});

it.each([7, 8])("enforces the Add Account limit at %i accounts", async (count) => {
  await render(count);
  expect(buttons("Add Account")).toHaveLength(count < 8 ? 1 : 0);
  expect(buttons("Sign Out")).toHaveLength(count);
});

it("disables actions while signing out and shows a retryable failure", async () => {
  await render();
  let reject!: (error: Error) => void;
  request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(buttons("Sign Out").every((button) => button.disabled)).toBe(true);
  expect(buttons("Add Account")[0]!.disabled).toBe(true);
  await act(async () => reject(new Error("")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Didn't finish");
  expect(buttons("Sign Out").every((button) => !button.disabled)).toBe(true);
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it.each(["en", "ko"] as const)("shows account refusal messages in %s", async (locale) => {
  persistPreference(locale);
  await render(1);
  request.mockRejectedValueOnce(new Error("Sign-in is already in progress"));
  await act(async () => buttons(locale === "en" ? "Add Account" : "계정 추가")[0]!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Sign-in is already in progress");
});

it("signs out with zero bots without selecting a destination", async () => {
  const bots = state.bots.splice(0);
  try {
    await render();
    await act(async () => buttons("Sign Out")[0]!.click());
    expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: "{}" });
    expect(host.textContent).not.toContain("Move");
    expect(host.querySelector('input, [role="radiogroup"]')).toBeNull();
  } finally { state.bots.push(...bots); }
});
