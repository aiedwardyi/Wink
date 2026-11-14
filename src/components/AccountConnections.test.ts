// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistPreference, I18nProvider } from "@/lib/i18n";
import { cn } from "@/lib/cn";
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
import { ROW_BUTTON } from "./SettingsPrimitives";

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

it("keeps each Connections email bound to its account id when Main and order change", async () => {
  await render(5);
  const labels = ["alex", "blair", "casey", "drew", "emery"];
  state.instances = state.instances.map((account, index) => ({ ...account,
    snapshot: { ...account.snapshot, account: `${labels[index]}@example.test` },
    pickerSnapshot: { state: "available" as const, authenticated: true, account: "drew@example.test" },
    accountMain: index === 3,
  })).reverse();
  await update();
  for (const account of state.instances) {
    const row = host.querySelector(`[data-connection-account="${account.instanceId}"]`);
    expect(row?.querySelector("[data-account-email]")?.textContent).toBe(account.snapshot.account);
  }
});

it.each(["en", "ko"] as const)("points a duplicate add to its existing row in %s", async (locale) => {
  persistPreference(locale);
  await render(2);
  request.mockImplementation(async (path: string) => path === "/api/accounts" ? { id: "duplicate" }
    : path === "/api/accounts/duplicate/sign-in" ? { state: "duplicate", existingId: "account-1" } : {});
  await act(async () => buttons(locale === "en" ? "Add Account" : "계정 추가")[0]!.click());
  expect(host.querySelector('[role="status"]')?.textContent).toContain(locale === "en" ? "Already added" : "이미 추가된 계정");
  const link = host.querySelector<HTMLButtonElement>("[data-existing-account]");
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  expect(document.activeElement?.getAttribute("data-connection-account")).toBe("account-1");
  expect(host.querySelectorAll("[data-connection-account]")).toHaveLength(2);
});

it("points a duplicate add to another profile of the same engine", async () => {
  await render(2);
  state.instances = [...state.instances, { ...engine("work"), accountOf: "work", accountMain: true }];
  await update();
  request.mockImplementation(async (path: string) => path === "/api/accounts" ? { id: "duplicate" }
    : path === "/api/accounts/duplicate/sign-in" ? { state: "duplicate", existingId: "work" } : {});
  await act(async () => buttons("Add Account")[0]!.click());
  const link = host.querySelector<HTMLButtonElement>("[data-existing-account]");
  expect(link?.textContent).toContain("work@example.com");
  await act(async () => link!.click());
  expect(document.activeElement?.getAttribute("data-connection-account")).toBe("work");
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

it.each([false, true])("shows a long email whole as plain text with phone %s", async (phone) => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: phone } as MediaQueryList);
  await render();
  const label = "averyveryverylongname@example-company.com";
  state.instances[0]!.snapshot.account = label;
  await update();
  const email = host.querySelector<HTMLElement>("[data-account-email]")!;
  expect(email.innerHTML).toBe(label);
  expect(email.title).toBe("");
  expect([...email.classList]).toEqual(expect.arrayContaining(["min-w-0", "break-words"]));
  expect(email.classList.contains("truncate")).toBe(false);
  expect(email.closest("button")).toBeNull();
  await act(async () => email.click());
  expect(host.querySelectorAll("[data-account-email]")).toHaveLength(2);
  expect(host.textContent!.split(label)).toHaveLength(2);
  expect(host.textContent).not.toContain("Main");
});

it.each([1, 2])("heads the engine above a card of %i account rows, with Add Account only on the engine header row", async (count) => {
  await render(count);
  const group = host.querySelector('[data-engine-row="claude"]')!;
  const [header] = [...group.children];
  const rows = [...group.querySelectorAll("[data-connection-account]")];
  expect(header!.querySelector("svg")).not.toBeNull();
  expect(header!.textContent).toBe("ClaudeAdd Account");
  expect(header!.textContent).not.toContain("@");
  expect(group.querySelectorAll("svg")).toHaveLength(1);
  expect(group.querySelectorAll("[data-engine-hover]")).toHaveLength(0);
  expect(rows).toHaveLength(count);
  expect(group.lastElementChild!.getAttribute("role")).toBe("group");
  expect([...group.lastElementChild!.children]).toEqual(rows);
  for (const [i, row] of rows.entries()) {
    expect(row.textContent).toContain(`${i ? `account-${i}` : "claude"}@example.com`);
    expect(row.textContent).toContain("Sign Out");
    expect(row.textContent).not.toContain("Add Account");
    expect(row.textContent).not.toContain("Claude");
  }
});

it("draws Sign Out, Add Account and Sign In as the Settings row button, with Sign Out quieter", async () => {
  await render();
  state.instances = [...state.instances, engine("account-2", false)];
  await update();
  expect(buttons("Sign Out").map((node) => node.className)).toEqual([ROW_BUTTON, ROW_BUTTON]);
  expect(buttons("Add Account")[0]!.className).toBe(cn(ROW_BUTTON, "text-ink"));
  expect(buttons("Sign In")[0]!.className).toBe(cn(ROW_BUTTON, "text-ink"));
  expect(buttons("Sign Out")[0]!.classList.contains("text-ink-secondary")).toBe(true);
  expect(buttons("Add Account")[0]!.classList.contains("text-ink-secondary")).toBe(false);
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

it.each((["complete", "failed", "cancelled", "removed"] as const).flatMap((outcome) =>
  (["en", "ko"] as const).map((locale) => ({ outcome, locale }))))("clears the $locale sign-in warning when it is $outcome", async ({ outcome, locale }) => {
  persistPreference(locale);
  for (const message of ["Sign-in is already in progress", "Another sign-in for this engine is still running"]) {
    await render(3);
    state.instances = [...state.instances, { ...engine("new", false), accountState: "pending", loginState: "pending" }];
    await update();
    request.mockRejectedValueOnce(new Error(message));
    await act(async () => buttons(locale === "en" ? "Add Account" : "계정 추가")[0]!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    state.instances = state.instances.map((account) => ({ ...account }));
    await update();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    state.instances = outcome === "removed" ? state.instances.filter((account) => account.instanceId !== "new")
      : state.instances.map((account) => account.instanceId !== "new" ? account
        : { ...engine("new", outcome === "complete"), accountState: outcome === "complete" ? "ready" : "pending", loginState: outcome });
    await update();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    if (outcome === "complete") expect(host.textContent).toContain("new@example.com");
  }
});

it("clears a late refusal for the settled sign-in even if another sign-in starts", async () => {
  await render(1);
  state.instances = [...state.instances, { ...engine("new", false), accountState: "pending", loginState: "pending" }];
  await update();
  let reject!: (error: Error) => void;
  request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => buttons("Add Account")[0]!.click());
  state.instances = [state.instances[0]!, { ...engine("new"), loginState: "pending" },
    { ...engine("other", false), accountState: "pending", loginState: "pending" }];
  await update();
  await act(async () => reject(new Error("Another sign-in for this engine is still running")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("new@example.com");
});

it("keeps a real error when the pending sign-in finishes", async () => {
  await render(1);
  state.instances = [...state.instances, { ...engine("new", false), accountState: "pending", loginState: "pending" }];
  await update();
  request.mockRejectedValueOnce(new Error("Sign-in failed"));
  await act(async () => buttons("Add Account")[0]!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Sign-in failed");
  state.instances = [state.instances[0]!, { ...engine("new", false), loginState: "failed" }];
  await update();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Sign-in failed");
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

it("drops Sign Out from an open phone menu when the account starts draining", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
  await render();
  const row = host.querySelector('[data-connection-account="account-1"]')!;
  await act(async () => row.querySelector<HTMLButtonElement>("[data-connection-menu]")!.click());
  expect(buttons("Sign Out")).toHaveLength(1);
  state.instances[1]!.drain = { destinationId: "claude", phase: "draining" };
  await update();
  expect(row.querySelector('[role="status"]')?.textContent).toBe("Signing out…");
  expect(buttons("Sign Out")).toHaveLength(0);
  expect(buttons("Retry Sign Out")).toHaveLength(0);
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
  expect(host.textContent).toContain("Add on computer");
  expect(request).not.toHaveBeenCalledWith("/api/accounts", expect.anything());
});

it.each([
  ["en", "Add on computer", "Sign in on computer"],
  ["ko", "컴퓨터에서 추가", "컴퓨터에서 로그인"],
] as const)("puts a computer-only action in the engine header's slot as a muted label, never a line below, in %s", async (locale, add, signIn) => {
  persistPreference(locale);
  await render(2);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  state.instances[0]!.install = { login: { args: ["auth", "login"] } };
  state.instances.push({ ...engine("gemini", false), accountOf: undefined, accountMain: undefined, accountState: undefined, driverKind: "antigravityAgent", displayName: "Gemini" });
  await update();
  for (const [id, label] of [["claude", add], ["gemini", signIn]] as const) {
    const group = host.querySelector(`[data-engine-row="${id}"]`)!;
    const slot = group.querySelector("[data-engine-head] [data-engine-slot]");
    expect(slot?.textContent, id).toBe(label);
    expect(slot!.querySelector("button")).toBeNull();
    expect(group.textContent!.split(label)).toHaveLength(2);
  }
  for (const slot of host.querySelectorAll("[data-connection-account] .justify-end")) expect(slot.classList.contains("whitespace-nowrap")).toBe(true);
});

it("offers recovery for a stopped account whose credentials remain valid", async () => {
  await render();
  state.instances[1]!.accountState = "stopped";
  await update();
  expect(buttons("Sign In")).toHaveLength(1);
  await act(async () => buttons("Sign In")[0]!.click());
  expect(request).toHaveBeenCalledWith("/api/instances/account-1/sign-in", { method: "POST", body: JSON.stringify({ device: false }) });
});


it.each(["en", "ko"] as const)("keeps pushed rows without a Main tag or account-list GET in %s", async (locale) => {
  persistPreference(locale);
  await render();
  const tag = locale === "en" ? "Main" : "기본";
  expect(host.textContent).toContain("claude@example.com");
  expect(host.textContent).not.toContain(tag);
  expect(request).not.toHaveBeenCalledWith("/api/accounts");
  state.instances = state.instances.map((account) => ({ ...account, accountMain: account.instanceId === "account-1" }));
  await update();
  expect(host.textContent).toContain("account-1@example.com");
  expect(host.textContent).not.toContain(tag);
  expect(request).not.toHaveBeenCalledWith("/api/accounts");
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

it("swaps the header slot between the computer-only label and Add Account, with no fold", async () => {
  await render(2);
  let phone = true;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width") }) as MediaQueryList);
  state.instances[0]!.install = { login: { args: ["auth", "login"] } };
  await update();
  const slot = () => host.querySelector('[data-engine-row="claude"] [data-engine-slot]');
  expect(slot()?.textContent).toBe("Add on computer");
  expect(host.querySelector('[data-engine-row="claude"] [data-fold]')).toBeNull();
  phone = false;
  await update();
  expect(slot()?.textContent).toBe("Add Account");
  expect(host.querySelector('[data-engine-row="claude"] [data-fold]')).toBeNull();
});
