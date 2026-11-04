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
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    calls.push({ path, init });
    if (path.startsWith("/api/usage/board")) return boardReply ? boardReply() : Response.json(structuredClone(board));
    if (path.endsWith("/name")) return reply ? reply() : Response.json({ id: "claude", number: 1, nickname: "Studio", name: "Studio" });
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
    for (const section of ["usage", "general", "account", "devices", "themes", "team", "models-index", "shortcuts"] as AppSettingsSection[]) {
      await act(async () => store.dispatch({ type: "toggleAppSettings", section, open: true }));
      await settle();
      expect(scanForCanary(canary), `${section}, phone=${phone}, ${locale}`).toEqual([]);
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
