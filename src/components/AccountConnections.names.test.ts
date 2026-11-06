// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeIdentityCanary, scanForCanary, type IdentityCanary } from "@/lib/identity-canary";
import { usageBoardFixture } from "@/lib/usage-board.fixture";
import type { UsageBoard } from "@/lib/usage-board";
import type { AppSettingsSection, InstanceInfo } from "@/state/store";

let m: {
  store: typeof import("@/state/store");
  connections: typeof import("./AccountConnections");
  settings: typeof import("./SettingsModal");
  i18n: typeof import("@/lib/i18n");
  client: typeof import("@/lib/usage-board-client");
};
let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof m.store.useStore>;
let canary: IdentityCanary;
let board: UsageBoard;
let accounts: InstanceInfo[];
let reply: (() => Promise<Response>) | null;
let boardReply: (() => Promise<Response>) | null;
let mutationReply: (() => Promise<Response>) | null;
let calls: { path: string; init?: RequestInit }[];
const matchMedia = window.matchMedia;
const row = () => host.querySelector<HTMLElement>('[data-connection-account="claude"]');
const button = (label: string, scope: ParentNode | null = host) => [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((node) => node.textContent === label);
const settle = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
async function click(node: HTMLElement | null | undefined) {
  expect(node, "control to click").toBeTruthy();
  await act(async () => node!.click());
  await settle();
}
async function input(value: string) {
  const node = host.querySelector<HTMLInputElement>('[data-account-name-editor] input');
  expect(node, "nickname input").not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function Capture({ settings }: { settings: boolean }) {
  store = m.store.useStore();
  return settings ? createElement(m.settings.SettingsModal) : createElement(m.connections.AccountConnections, { accounts, reload: store.refreshInstances });
}
async function mount({ phone = false, locale = "en", settings = false }: { phone?: boolean; locale?: "en" | "ko"; settings?: boolean } = {}) {
  window.matchMedia = ((query: string) => ({ matches: phone && (query.includes("max-width") || query.includes("pointer: coarse")), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  m.i18n.persistPreference(locale);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(m.i18n.I18nProvider, null,
    createElement(m.store.StoreProvider, null, createElement(Capture, { settings })))));
  await act(async () => {
    store.dispatch({ type: "instances", instances: accounts });
    if (settings) store.dispatch({ type: "toggleAppSettings", section: "connections", open: true });
  });
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
  host.remove();
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  canary = makeIdentityCanary();
  board = structuredClone(usageBoardFixture);
  accounts = board.engines[0]!.accounts.map((account): InstanceInfo => ({
    instanceId: account.id, accountOf: "claude", accountMain: account.main, accountState: "ready",
    driverKind: "claudeAgent", displayName: "Claude", models: { default: "model", options: [] },
    snapshot: { state: "available", authenticated: true, account: canary.address },
    install: { login: { args: ["login"], deviceArgs: ["login", "--device"] } },
  }));
  calls = [];
  reply = null;
  boardReply = null;
  mutationReply = null;
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push({ path, init });
    if (path.startsWith("/api/usage/board")) return boardReply ? boardReply() : Response.json(structuredClone(board));
    if (path.endsWith("/name")) return reply ? reply() : Response.json({ id: "claude", number: 1, nickname: "Studio", name: "Studio" });
    if (path === "/api/accounts" && init?.method === "POST" && mutationReply) return mutationReply();
    return new Promise<Response>(() => {});
  }));
  m = { store: await import("@/state/store"), connections: await import("./AccountConnections"), settings: await import("./SettingsModal"),
    i18n: await import("@/lib/i18n"), client: await import("@/lib/usage-board-client") };
});
afterEach(async () => {
  if (host?.isConnected) await unmount();
  document.body.replaceChildren();
  window.matchMedia = matchMedia;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps account identities inside Connections account rows", async () => {
  for (const [phone, locale] of [[false, "en"], [true, "en"], [false, "ko"], [true, "ko"]] as const) {
    await mount({ phone, locale, settings: true });
    const scan = () => {
      const rows = [...host.querySelectorAll<HTMLElement>("[data-connection-account]")];
      expect(rows, "scoped Connections account rows").toHaveLength(3);
      for (const account of rows) {
        expect(scanForCanary(canary, account).filter((hit) => hit.where !== "text"), "identity is text only").toEqual([]);
      }
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[data-connection-account]").forEach((node) => node.remove());
      expect(scanForCanary(canary, clone), "outside account rows").toEqual([]);
    };
    scan();
    for (const node of host.querySelectorAll<HTMLElement>("button, svg")) {
      await act(async () => {
        node.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
        node.focus();
        node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      });
      scan();
    }
    if (phone) await click(row()!.querySelector<HTMLElement>('[data-connection-menu]'));
    await click(button(locale === "en" ? "Name" : "이름", row()!));
    expect(host.querySelector<HTMLInputElement>("[data-account-name-editor] input")!.value).toBe("");
    expect(scanForCanary(canary, host.querySelector("[data-account-name-editor]")!)).toEqual([]);
    await input("Studio");
    reply = async () => Response.json({ code: "taken", error: canary.address }, { status: 400 });
    await click(button(locale === "en" ? "Save" : "저장"));
    scan();
    await click(button(locale === "en" ? "Cancel" : "취소", host.querySelector("[data-account-name-editor]")!));
    mutationReply = async () => Response.json({ error: `Busy ${canary.address} ${canary.local} ${canary.domain}` }, { status: 409 });
    await click(button(locale === "en" ? "Add Account" : "계정 추가"));
    expect(host.querySelector('[role="alert"]'), "Add Account failure").not.toBeNull();
    scan();
    for (const section of ["usage", "general", "account", "companion", "themes", "team", "models-index", "shortcuts"] satisfies AppSettingsSection[]) {
      await act(async () => store.dispatch({ type: "toggleAppSettings", section, open: true }));
      await settle();
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[data-account-email]").forEach((el) => { el.textContent = ""; });
      expect(scanForCanary(canary, clone), `${section}, phone=${phone}, ${locale}`).toEqual([]);
    }
    await unmount();
  }
});

it("renames an account through the names API", async () => {
  await mount();
  expect(row()?.textContent ?? "").toContain("Claude 1");
  expect(row()?.querySelector("[data-account-number]")?.textContent).toBe("1");
  await click(button("Name", row()!));
  await input("  Studio  ");
  await click(button("Save"));
  expect(calls.find(({ path }) => path.endsWith("/name"))).toMatchObject({ path: "/api/accounts/claude/name", init: { method: "POST", body: '{"nickname":"Studio"}' } });
  expect(row()?.textContent).toContain("Studio");
  expect(host.querySelector("[data-account-name-editor]")).toBeNull();
  board.engines[0]!.accounts[0]!.name = "Remote";
  board.revision++;
  await act(async () => m.client.usageBoardFrame(board.revision));
  await settle();
  expect(row()?.textContent).toContain("Remote");
  expect(row()?.textContent).not.toContain("Studio");
  expect(calls.some(({ path }) => path === "/api/accounts")).toBe(false);
});

it.each(["en", "ko"] as const)("keeps the original number tile beside phone account names in %s", async (locale) => {
  await mount({ phone: true, locale });
  const tile = row()?.querySelector("[data-account-number]");
  expect(tile?.textContent).toBe("1");
  expect(tile?.parentElement?.className).toBe("flex h-9 min-w-0 items-center gap-2 pr-10 [@media(pointer:coarse)]:h-11");
  expect(tile?.nextElementSibling?.getAttribute("data-edit-name")).toBe("");
});

it.each(["en", "ko"] as const)("distinguishes identity buttons by account name without email in %s", async (locale) => {
  await mount({ locale });
  const labels = [...host.querySelectorAll('[data-connection-identity]')].map((node) => node.getAttribute("aria-label"));
  expect(new Set(labels).size).toBe(accounts.length);
  expect(labels[0]).toContain("Claude 1");
  for (const label of labels) expect(label).not.toContain(canary.address);
});

it("clears a nickname with an empty name", async () => {
  board.engines[0]!.accounts[0]!.nickname = "Studio";
  board.engines[0]!.accounts[0]!.name = "Studio";
  reply = async () => Response.json({ id: "claude", number: 1, nickname: null, name: "Claude 1" });
  await mount();
  await click(button("Name", row()!));
  expect(host.querySelector<HTMLInputElement>("[data-account-name-editor] input")!.value).toBe("Studio");
  await input("   ");
  await click(button("Save"));
  expect(calls.find(({ path }) => path.endsWith("/name"))?.init?.body).toBe('{"nickname":null}');
  expect(row()?.textContent).toContain("Claude 1");
});

it("renames a Codex account through its own route", async () => {
  accounts = [{ ...accounts[0]!, instanceId: "codex", accountOf: "codex", driverKind: "codex", displayName: "Codex" }];
  reply = async () => Response.json({ id: "codex", number: 1, nickname: "Studio", name: "Studio" });
  await mount();
  await click(button("Name"));
  await input("Studio");
  await click(button("Save"));
  expect(calls.find(({ path }) => path.endsWith("/name"))?.path).toBe("/api/accounts/codex/name");
  expect(host.querySelector('[data-connection-account="codex"]')?.textContent).toContain("Studio");
});

it("holds update reload while a name save is pending", async () => {
  const { reloadHeld } = await import("@/lib/reload-hold");
  await mount();
  await click(button("Name"));
  await input("Studio");
  let finish!: (response: Response) => void;
  reply = () => new Promise((resolve) => { finish = resolve; });
  await click(button("Save"));
  try { expect(reloadHeld(), "the names mutation holds the update reload").toBe(true); }
  finally {
    await act(async () => finish(Response.json({ id: "claude", number: 1, nickname: "Studio", name: "Studio" })));
    await settle();
  }
  expect(reloadHeld()).toBe(false);
});

it.each([["grok", "grokAgent"], ["gemini", "geminiAgent"], ["muse", "museAgent"]])("offers no Name control for %s even with a board row", async (id, driverKind) => {
  if (id === "muse") board.engines.push({ engine: "muse", base: id!, mainId: id!, events: [],
    accounts: [{ ...board.engines[0]!.accounts[0]!, id: id!, nickname: null, name: "Muse" }] });
  accounts = [{ ...accounts[0]!, instanceId: id!, accountOf: id!, driverKind: driverKind!, displayName: id! }];
  await mount();
  expect(host.querySelector("[data-account-number]"), "the board row is present").not.toBeNull();
  expect(button("Name")).toBeUndefined();
});

const errors = [
  ["too-long", "Use 24 characters or fewer", "24자 이내로 입력하세요"],
  ["invalid-character", "This name contains a character that is not allowed", "이름에 사용할 수 없는 문자가 있어요"],
  ["taken", "This name is already used for this engine", "이 엔진에서 이미 사용 중인 이름이에요"],
  ["reserved", "Choose a different name", "다른 이름을 입력하세요"],
  ["unknown-account", "This account is no longer available", "이 계정은 더 이상 사용할 수 없어요"],
] as const;
it.each(["en", "ko"] as const)("shows each names API error in en and ko (%s)", async (locale) => {
  await mount({ locale });
  await click(button(locale === "en" ? "Name" : "이름", row()!));
  await input("Studio");
  for (const [code, en, ko] of errors) {
    reply = async () => Response.json({ code, error: canary.address }, { status: code === "unknown-account" ? 404 : 400 });
    await click(button(locale === "en" ? "Save" : "저장"));
    expect(host.querySelector('[role="alert"]')?.textContent, code).toBe(locale === "en" ? en : ko);
    expect(scanForCanary(canary, host.querySelector("[data-account-name-editor]")!)).toEqual([]);
  }
});

it("hides the name editor until the board holds the account", async () => {
  boardReply = () => new Promise(() => {});
  await mount();
  expect(button("Name")).toBeUndefined();
  expect(host.querySelector("[data-account-number]")).toBeNull();
  expect(host.textContent).toContain(canary.address);
  await unmount();
  vi.resetModules();
  m.connections = await import("./AccountConnections");
  m.store = await import("@/state/store");
  m.i18n = await import("@/lib/i18n");
  boardReply = async () => Response.json({ error: "not found" }, { status: 404 });
  await mount();
  expect(button("Name")).toBeUndefined();
  expect(host.querySelector("[data-account-number]")).toBeNull();
  await unmount();
  vi.resetModules();
  m.connections = await import("./AccountConnections");
  m.store = await import("@/state/store");
  m.i18n = await import("@/lib/i18n");
  boardReply = null;
  board.engines[0]!.accounts = board.engines[0]!.accounts.slice(1);
  await mount();
  expect(button("Name", row()!)).toBeUndefined();
  expect(row()?.querySelector("[data-account-number]") ?? null).toBeNull();
  expect(button("Name")).toBeDefined();
});

it.each([false, true])("opens a long identity inside its row by keyboard and touch (phone=%s)", async (phone) => {
  await mount({ phone });
  const trigger = row()?.querySelector<HTMLButtonElement>("[data-connection-identity]");
  expect(trigger, "identity disclosure").toBeTruthy();
  expect(trigger?.hasAttribute("title")).toBe(false);
  expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    trigger!.focus();
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    trigger!.click();
  });
  expect(row()?.querySelector("[data-connection-identity-body]")?.textContent).toContain(canary.address);
  await click(trigger);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(row()?.querySelector("[data-connection-identity-body]")).toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    trigger!.click();
  });
  expect(row()?.querySelector("[data-connection-identity-body]")?.textContent).toContain(canary.address);
});

it.each([false, true])("gives the address its own line under the name on a phone (phone=%s)", async (phone) => {
  await mount({ phone });
  const line = row()!.firstElementChild!;
  const identity = line.querySelector<HTMLElement>("[data-connection-identity]")!;
  expect(identity.querySelector("[data-account-email]")?.textContent).toBe(canary.address);
  expect(identity.parentElement?.firstElementChild?.querySelector("[data-edit-name]")?.textContent).toBe("Claude 1");
  expect(identity.parentElement?.className).toContain("flex-col");
  if (!phone) {
    expect(row()!.querySelector("[data-connection-menu]")).toBeNull();
    return;
  }
  const more = row()!.querySelector<HTMLElement>("[data-connection-menu]")!;
  expect(line.contains(more), "the address runs under the more button").toBe(false);
  expect(more.querySelector("svg"), "an icon, not a text glyph").not.toBeNull();
  expect(more.textContent).toBe("");
});

it("keeps a signed-out account's editor on its name row", async () => {
  accounts[0]!.snapshot.authenticated = false;
  await mount();
  await click(button("Name", row()!));
  const nameLine = row()!.querySelector("[data-account-number]")!.parentElement!;
  expect(nameLine.querySelector("[data-account-name-editor] input")).not.toBeNull();
});

it.each([
  ["signed-out", "Sign In", {}],
  ["still signing in", "Cancel", { loginState: "pending", loginCapture: { url: "https://example.com/device" } }],
] as const)("keeps one menu, on the name row, for a %s named account on a phone", async (_state, action, signIn) => {
  Object.assign(accounts[0]!, { snapshot: { state: "available", authenticated: false }, ...signIn });
  await mount({ phone: true });
  const menus = row()!.querySelectorAll<HTMLElement>("[data-connection-menu]");
  expect(menus, `no second menu floating over ${action}`).toHaveLength(1);
  expect(menus[0]!.closest(".absolute"), "the menu is not an overlay").toBeNull();
  let line = menus[0]!.parentElement;
  while (line && line !== row() && !line.textContent?.includes("Claude 1")) line = line.parentElement;
  expect(line, "it sits on the name row, not on the account as a whole").not.toBe(row());
  expect(button(action, row()), `${action} shows`).toBeTruthy();
  expect(line!.contains(button(action, row())!), `${action} sits on its own row, clear of the menu`).toBe(false);
});
