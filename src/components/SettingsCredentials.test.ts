import "./ProfileFields.test-dom";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { persistPreference, I18nProvider } from "@/lib/i18n";
import { catalogs } from "@/lib/i18n-catalog";
import type { Bot } from "@/state/store";

const { state, dispatch } = vi.hoisted(() => ({
  state: { config: { composio: { configured: true }, box: { configured: true }, tts: { provider: "elevenlabs", configured: false }, imageGen: { configured: false }, customKeys: [{ host: "api.acme.dev", name: "Acme" }] }, bots: [] },
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state, dispatch, flushBotPatches: vi.fn() }),
}));
import { SavedKeys } from "./ApiKeys";
import { VoiceSettings } from "./VoiceSettings";

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  Object.assign(window, { ogb: undefined });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dispatch.mockClear();
  persistPreference("en");
});

async function mount(element: ReactElement, locale: "en" | "ko" = "en") {
  vi.stubGlobal("localStorage", window.localStorage);
  persistPreference(locale);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, element)));
}

async function saveInput() {
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-only-settings-key");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => (input.nextElementSibling as HTMLButtonElement).click());
}

async function removeSavedKey() {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click());
  await act(async () => (host.querySelector('button[aria-label]') as HTMLButtonElement).click());
  await act(async () => document.querySelector('[role="dialog"]')!.querySelectorAll("button")[1].click());
}

const bot = { id: "bot", name: "Bot", color: "blue" } as Bot;
const rows: [string, () => ReactElement][] = [
  ["ttsKey", () => createElement(VoiceSettings, { bot, onPatch: vi.fn() })],
];

it("localizes credential failures for every Settings save and removal in English and Korean, preserving unknown errors", async () => {
  const failures = [
    ["desktop-unavailable", "secret.desktopUnavailable"],
    ["credential-rejected", "secret.credentialRejected"],
    ["credential-save-timeout", "secret.saveTimeout"],
    ["invalid-credential", "secret.invalidCredential"],
    ["credential-save-failed", "secret.saveFailed"],
    ["unknown-save-error", null],
  ] as const;
  const actions: [() => ReactElement, () => Promise<void>][] = [
    ...rows.map(([, element]) => [element, saveInput] as [() => ReactElement, () => Promise<void>]),
    [() => createElement(SavedKeys), removeSavedKey],
  ];
  for (const locale of ["en", "ko"] as const) {
    for (const [code, key] of failures) {
      vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(
        path === "/api/key-uses" ? { uses: {} } : { error: code },
      ), { status: path === "/api/key-uses" ? 200 : 503 })));
      for (const [element, action] of actions) {
        await mount(element(), locale);
        await action();
        expect(host.textContent).toContain(key ? catalogs[locale][key] : code);
        await act(async () => root.unmount());
        host.remove();
      }
    }
  }
});

it.each(rows)("saves remote Settings %s through the owner's credential route", async (target, element) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: true, config: state.config })));
  vi.stubGlobal("fetch", fetchMock);
  await mount(element());
  await saveInput();
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/api/credentials");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string).target).toBe(target);
  expect(dispatch.mock.calls.at(-1)?.[0].config).toEqual(state.config);
});

it("removes a remote saved custom key through the encrypted route", async () => {
  const fetchMock = vi.fn(async (path: string) => new Response(JSON.stringify(path === "/api/key-uses" ? { uses: {} } : { saved: true, config: state.config })));
  vi.stubGlobal("fetch", fetchMock);
  await mount(createElement(SavedKeys));
  await removeSavedKey();
  const [path, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(path).toBe("/api/credentials");
  expect(JSON.parse(init.body as string)).toEqual({ target: "custom:api.acme.dev", value: "" });
});

it("preserves the owner desktop Settings preload path", async () => {
  const setCredential = vi.fn(async () => state.config);
  Object.assign(window, { ogb: { setCredential } });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await mount(createElement(VoiceSettings, { bot, onPatch: vi.fn() }));
  await saveInput();
  expect(setCredential).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps the remote Settings input until encrypted storage confirms the save", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ saved: false, config: state.config }))));
  await mount(createElement(VoiceSettings, { bot, onPatch: vi.fn() }));
  await saveInput();
  expect(dispatch).not.toHaveBeenCalled();
  expect(Boolean((host.querySelector('input[type="password"]') as HTMLInputElement).value)).toBe(true);
});
