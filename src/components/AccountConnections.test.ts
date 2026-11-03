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
const engine = (id: string, signedIn = true): InstanceInfo => ({
  accountOf: id === "codex" ? "codex" : "claude", accountState: "ready", accountMain: id === "claude" || id === "codex",
  instanceId: id, driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: signedIn, account: `${id}@example.com` },
  models: { default: "opus", options: [] },
  install: { login: { args: ["login"], deviceArgs: ["login", "--device"] } },
});
const buttons = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.textContent === name);
async function render(count = 2) {
  state.instances = Array.from({ length: count }, (_, i) => engine(i ? `account-${i}` : "claude"));
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
  request.mockReset().mockImplementation(async (path: string) => path.endsWith("/destination") ? { destinationId: state.instances.find((account) => !account.accountMain && account.accountState === "ready" && account.snapshot.authenticated)?.instanceId } : path === "/api/accounts" ? { accounts: state.instances.map((account) => ({
    id: account.instanceId, of: account.accountOf, state: account.accountState, default: account.accountMain,
  })) } : {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["en", "ko"] as const)("signs out a non-main account in one tap in %s", async (locale) => {
  persistPreference(locale);
  await render(3);
  const name = locale === "en" ? "Sign Out" : "로그아웃";
  expect(buttons(name)).toHaveLength(3);
  await act(async () => buttons(name)[1]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/account-1/sign-out", { method: "POST", body: "{}" });
  expect(request.mock.calls.filter(([path]) => String(path).endsWith("/sign-out"))).toHaveLength(1);
  expect(host.querySelector('input, [role="radiogroup"]')).toBeNull();
  expect(host.textContent).not.toMatch(/Move|bots? use|옮|봇/);
});

it("keeps main-account sign-out disabled when no other account is ready", async () => {
  await render();
  state.instances[1] = engine("account-1", false);
  await update();
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(request.mock.calls.some(([path]) => String(path).endsWith("/sign-out"))).toBe(false);
  expect(buttons("Sign Out")[0]!.disabled).toBe(true);
  expect(host.textContent).toContain("Signed out.");
  expect(buttons("Sign In")).toHaveLength(1);
});

it("names connected accounts and shows a long label in full, wrapping after @", async () => {
  await render();
  const label = "personal.account.with.a.very.long.address@example.com";
  state.instances[1]!.snapshot.account = label;
  await update();
  expect(host.textContent).toContain("claude@example.com");
  const identity = [...host.querySelectorAll("span")].find((node) => node.textContent === label)!;
  expect(identity.classList.contains("truncate")).toBe(false);
  expect(identity.innerHTML).toBe("personal.account.with.a.very.long.address@<wbr>example.com");
  expect(buttons("Sign Out")).toHaveLength(2);
});

it.each([1, 2])("puts each of %i accounts and its icon on one row, with Add Account on the first", async (count) => {
  await render(count);
  const group = host.querySelector('[data-engine-row="claude"]')!;
  const marks = group.querySelectorAll('[data-engine-hover]');
  expect(marks).toHaveLength(count);
  for (const [i, mark] of [...marks].entries()) {
    const row = mark.parentElement!.parentElement!;
    expect(row.textContent).toContain(`${i ? `account-${i}` : "claude"}@example.com`);
    expect(row.textContent).toContain("Sign Out");
    expect(row.textContent?.includes("Add Account")).toBe(i === 0);
  }
  expect(group.textContent).not.toContain("Claude");
});

it.each(["claudeAgent", "codex", "grokAgent", "museAgent", "antigravityAgent"])("offers only Sign In while %s is signed out", async (driverKind) => {
  state.instances = [{ ...engine("claude", false), driverKind }];
  await update();
  expect(buttons("Sign In")).toHaveLength(1);
  expect(buttons("Add Account")).toHaveLength(0);
});

it("skips stopped and loading accounts when choosing Main's destination", async () => {
  await render(4);
  state.instances[1]!.accountState = "stopped";
  state.instances[2]!.snapshot = { state: "available" };
  await update();
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: JSON.stringify({ destinationId: "account-3" }) });
});

it("uses the server's compatible destination for Main sign-out", async () => {
  await render(3);
  request.mockImplementation(async (path: string) => path.endsWith("/destination") ? { destinationId: "account-2" } : {});
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/destination");
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: JSON.stringify({ destinationId: "account-2" }) });
});

it("keeps Main signed in when compatible destination selection fails", async () => {
  await render(3);
  request.mockImplementation(async (path: string) => {
    if (path.endsWith("/destination")) throw new Error("This account does not offer the selected model; choose a model first");
    return {};
  });
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(request.mock.calls.some(([path]) => path.endsWith("/sign-out"))).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("selected model");
});

it.each(["en", "ko"] as const)("localizes a missing ready destination in %s", async (locale) => {
  persistPreference(locale);
  await render(3);
  request.mockRejectedValueOnce(new Error("No ready account can take over this profile"));
  await act(async () => buttons(locale === "en" ? "Sign Out" : "로그아웃")[0]!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(locale === "en"
    ? "No ready account can take over this profile" : "이 프로필을 이어받을 준비된 계정이 없어요");
  expect(request.mock.calls.some(([path]) => path.endsWith("/sign-out"))).toBe(false);
});

it.each(["Personal account", undefined])("uses the engine account label without an email (%s)", async (label) => {
  await render(1);
  state.instances[0]!.snapshot.account = label;
  await update();
  expect(host.textContent).toContain(label ?? "Claude");
  expect(buttons("Sign Out")).toHaveLength(1);
});

it.each(["en", "ko"] as const)("offers one Add Account per engine, including a single account, in %s", async (locale) => {
  persistPreference(locale);
  await render(1);
  state.instances = [...state.instances, { ...engine("codex"), driverKind: "codex", displayName: "Codex" }];
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
      return { id: "new", state: "pending" };
    }
    return {};
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
  await act(async () => buttons("Sign Out")[1]!.click());
  expect(buttons("Sign Out").every((button) => button.disabled)).toBe(true);
  expect(buttons("Add Account")[0]!.disabled).toBe(true);
  await act(async () => reject(new Error("")));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Didn't finish");
  expect(buttons("Sign Out")[1]!.disabled).toBe(false);
  await act(async () => buttons("Sign Out")[1]!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it.each(["en", "ko"] as const)("shows account refusal messages in %s", async (locale) => {
  persistPreference(locale);
  await render(1);
  request.mockRejectedValueOnce(new Error("Sign-in is already in progress"));
  await act(async () => buttons(locale === "en" ? "Add Account" : "계정 추가")[0]!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Sign-in is already in progress");
});

it("signs out the main account with zero bots through the destination path", async () => {
  const bots = state.bots.splice(0);
  try {
    await render();
    await act(async () => buttons("Sign Out")[0]!.click());
    expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: JSON.stringify({ destinationId: "account-1" }) });
    expect(host.textContent).not.toContain("Move");
    expect(host.querySelector('input, [role="radiogroup"]')).toBeNull();
  } finally { state.bots.push(...bots); }
});

it.each(["en", "ko"] as const)("signs out Main through another ready account in %s", async (locale) => {
  persistPreference(locale);
  await render();
  const name = locale === "en" ? "Sign Out" : "로그아웃";
  expect(buttons(name)[0]!.disabled).toBe(false);
  await act(async () => buttons(name)[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: JSON.stringify({ destinationId: "account-1" }) });
  state.instances[0]!.accountMain = false;
  state.instances[1]!.accountMain = true;
  state.instances = [...state.instances];
  await update();
  expect(buttons(name)[0]!.disabled).toBe(false);
  expect(buttons(name)[1]!.disabled).toBe(false);
  await act(async () => buttons(name)[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: "{}" });
});

it("keeps single-account sign-out unchanged", async () => {
  await render(1);
  expect(buttons("Sign Out")[0]!.disabled).toBe(false);
  await act(async () => buttons("Sign Out")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/claude/sign-out", { method: "POST", body: "{}" });
});

it.each([false, true])("retries a failed drain with its recorded destination when Main is %s", async (main) => {
  await render();
  state.instances[1]!.accountMain = main;
  state.instances[1]!.drain = { destinationId: "claude", phase: "failed" };
  await update();
  expect(buttons("Retry Sign Out")).toHaveLength(1);
  expect(buttons("Retry Sign Out")[0]!.disabled).toBe(false);
  await act(async () => buttons("Retry Sign Out")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts/account-1/sign-out", {
    method: "POST", body: JSON.stringify({ destinationId: "claude" }),
  });
});

it.each(["en", "ko"] as const)("submits a managed Claude browser code without exposing it in %s", async (locale) => {
  persistPreference(locale);
  await render();
  state.instances[1] = { ...engine("account-1", false), loginState: "pending",
    loginCapture: { url: "https://claude.com/cai/oauth/authorize?code=true", inputGeneration: 7 } };
  await update();
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(input).not.toBeNull();
  expect(input.placeholder).toBe(locale === "en" ? "Paste the code here" : "여기에 코드를 붙여넣으세요");
  expect(host.textContent).toContain(locale === "en" ? "Sign in with your browser" : "브라우저로 로그인하세요");
  await act(async () => {
    input.value = "returned-code#state";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  request.mockResolvedValue({});
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(request).toHaveBeenCalledWith("/api/accounts/account-1/sign-in/code", {
    method: "POST", body: JSON.stringify({ code: "returned-code#state", generation: 7 }),
  });
  expect(host.textContent).not.toContain("returned-code#state");
  expect(input.value).toBe("");
});

it("uses browser login when Claude does not advertise device login", async () => {
  await render(1);
  state.instances[0]!.install = { login: { args: ["auth", "login"] } };
  await update();
  await act(async () => buttons("Add Account")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/accounts", { method: "POST", body: JSON.stringify({ of: "claude", device: false }) });
});

it("keeps computer-only guidance for Claude account creation on a phone", async () => {
  await render(1);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  state.instances[0]!.install = { login: { args: ["auth", "login"] } };
  await update();
  expect(buttons("Add Account")).toHaveLength(0);
  expect(host.textContent).toContain("Sign in on a computer");
  expect(request).not.toHaveBeenCalledWith("/api/accounts", expect.anything());
});

it("offers recovery for a stopped account whose credentials remain valid", async () => {
  await render();
  state.instances[1]!.accountState = "stopped";
  await update();
  expect(buttons("Sign In")).toHaveLength(1);
  await act(async () => buttons("Sign In")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/instances/account-1/sign-in", { method: "POST", body: JSON.stringify({ device: false }) });
});


it.each(["en", "ko"] as const)("shows the Main tag next to its email from pushed rows in %s", async (locale) => {
  persistPreference(locale);
  await render();
  const tag = locale === "en" ? "Main" : "기본";
  const mainTag = () => [...host.querySelectorAll("span")].find((span) => span.textContent === tag)!;
  expect(mainTag().parentElement?.textContent).toContain(`claude@example.com${tag}`);
  expect(request).not.toHaveBeenCalledWith("/api/accounts");
  state.instances = state.instances.map((account) => ({ ...account, accountMain: account.instanceId === "account-1" }));
  await update();
  expect(mainTag().parentElement?.textContent).toContain(`account-1@example.com${tag}`);
});

it("shows an accepted account as soon as the server pushes its signed-in row", async () => {
  await render(1);
  state.instances = [...state.instances, { ...engine("new", false), accountState: "pending" }];
  await update();
  expect(host.textContent).not.toContain("new@example.com");
  state.instances = [state.instances[0]!, engine("new")];
  await update();
  expect(host.textContent).toContain("new@example.com");
  expect(request).not.toHaveBeenCalledWith("/api/accounts");
});
