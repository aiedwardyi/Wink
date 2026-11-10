import "./ProfileFields.test-dom.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { createBotPatchQueue } from "@/state/bot-patch-queue";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "ChatView.tsx"), "utf8");
const settingsPanel = readFileSync(join(here, "SettingsPanel.tsx"), "utf8");

let avatarRequest = 0;
const scrolled = vi.fn();

// oxlint-disable-next-line anti-slop/no-module-mocking -- Bot details reads the shared store; this harness only varies the avatar request.
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        instances: [
          {
            instanceId: "claude",
            driverKind: "claudeAgent",
            displayName: "Claude",
            snapshot: { state: "available", authenticated: true, version: "1.0.13" },
            models: { default: "claude-3-5-sonnet", options: [{ id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }] },
            capabilities: {},
          },
        ],
        bots: [],
        config: {},
        mascotMotion: null,
        settingsAvatarRequest: avatarRequest,
      },
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- Desktop capability probes need a packaged host.
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "other", homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Voice controls need a host audio device.
vi.mock("./VoiceSettings", () => ({
  VoiceSettings: () => null,
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The picker body is a separate card; this test only checks that it is open.
vi.mock("./BotProfileAvatarCard", () => ({
  BotProfileAvatarCard: () => createElement("div", { "data-avatar-picker": "" }),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- The local-computer warning is outside the avatar block.
vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: () => null,
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Cloud backend choices are outside the avatar block.

import { SettingsPanel } from "./SettingsPanel";

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });

// SAFETY: the avatar block reads id, name, and modelSelection; the rest of Bot stays unused.
const bot = {
  id: "bot-1",
  threadId: "t1",
  name: "Friend",
  title: "",
  description: "",
  notifications: false,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
  messages: [],
} as Bot;

afterEach(() => {
  localStorage.setItem("omb-locale", "en");
  document.body.replaceChildren();
  avatarRequest = 0;
  scrolled.mockClear();
});

async function renderPanel(value = bot) {
  HTMLElement.prototype.scrollIntoView = () => {
    scrolled();
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: value })));
  });
  return { host, root };
}

describe("chat avatar opens Bot Details collapsed", () => {
  it("opens collapsed from the header avatar and keeps Customize in the catalog", () => {
    expect(chatView).not.toContain("avatar: !isPhone()");
    expect(chatView).toContain('onActivate={() => dispatch({ type: "toggleSettings", open: true })}');
    expect(settingsPanel).toContain("settingsAvatarRequest");
    expect(settingsPanel).toContain("scrollIntoView");
    expect(settingsPanel).toContain('t("bot.avatarCustomize")');
    expect(settingsPanel).toContain('t("bot.avatarDone")');
    expect(en["bot.avatarCustomize"]).toBe("Customize");
    expect(ko["bot.avatarCustomize"]).toBe("꾸미기");
    expect(en["bot.avatarDone"]).toBe("Done");
    expect(ko["bot.avatarDone"]).toBe("완료");
  });

  it("starts closed from the pencil", async () => {
    localStorage.setItem("omb-locale", "ko");
    avatarRequest = 0;
    const { root } = await renderPanel();
    try {
      expect(document.body.textContent).toContain("꾸미기");
      expect(document.querySelector("[data-avatar-picker]")).toBeNull();
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("starts open and scrolls the avatar block into view", async () => {
    avatarRequest = 1;
    const { root } = await renderPanel();
    try {
      expect(document.body.textContent).toContain("Done");
      expect(document.querySelector("[data-avatar-picker]")).not.toBeNull();
      expect(scrolled).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("Bot Details field padding", () => {
  it.each(["en", "ko"] as const)("does not activate profile fields from row padding in %s", async (locale) => {
    localStorage.setItem("omb-locale", locale);
    const { host, root } = await renderPanel({ ...bot, description: "Keep the editing position.\n".repeat(100) });
    try {
      const rows = host.querySelectorAll("label");
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        const padding = new MouseEvent("click", { bubbles: true, cancelable: true });
        row.dispatchEvent(padding);
        expect(padding.defaultPrevented).toBe(true);
        for (const target of [row.firstElementChild!, row.querySelector("input, textarea")!]) {
          const click = new MouseEvent("click", { bubbles: true, cancelable: true });
          target.dispatchEvent(click);
          expect(click.defaultPrevented).toBe(false);
        }
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("Description saved status", () => {
  let queue: ReturnType<typeof createBotPatchQueue>;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let requests: Array<{ resolve: () => void; reject: () => void }>;
  let id = 0;
  const value = () => ({ ...bot, id: `description-save-${id}`, description: "Keep the editing position.\n".repeat(100) });
  const row = () => host.querySelector("textarea")!.closest("label")!;
  const saved = () => row().querySelector('[role="status"] > span');
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const edit = () => act(async () => { queue.enqueue(value().id, { description: "Updated description" }, value()); });
  const land = () => act(async () => { requests.at(-1)!.resolve(); });
  const start = async (locale = "en") => {
    localStorage.setItem("omb-locale", locale);
    ({ host, root } = await renderPanel(value()));
  };

  beforeEach(() => {
    id += 1;
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "", revision: "r", topics: [], truncated: false })));
    requests = [];
    queue = createBotPatchQueue({
      send: () => new Promise((resolve, reject) => requests.push({ resolve: () => resolve(value()), reject: () => reject(new Error("Save failed")) })),
      reconcile: async () => value(),
      onAuthoritative: vi.fn(),
      onError: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); queue.dispose(); });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["en", "ko"] as const)("shows only an acknowledged save for two seconds in %s", async (locale) => {
    await start(locale);
    expect(saved()).toBeNull();
    await edit();
    await tick(400);
    expect(saved()).toBeNull();
    await land();
    expect(saved()?.textContent).toBe(locale === "en" ? "Saved" : "저장됨");
    expect(saved()?.querySelector("svg")?.getAttribute("width")).toBe("12");
    expect(saved()?.className).toContain("text-success");
    expect(row().firstElementChild?.className).toContain("sticky top-0");
    expect(row().querySelector("textarea")?.getAttribute("aria-label")).toBe(locale === "en" ? "Instructions" : "지침");
    await tick(1999);
    expect(saved()?.hasAttribute("data-closing")).toBe(false);
    await tick(1);
    expect(saved()?.hasAttribute("data-closing")).toBe(true);
    await tick(PRESENCE_EXIT_MS);
    expect(saved()).toBeNull();
  });

  it("never shows an earlier save while a newer description is pending", async () => {
    await start();
    await edit();
    await tick(400);
    await edit();
    await tick(400);
    await land();
    expect(saved()).toBeNull();
    expect(requests).toHaveLength(2);
    await land();
    expect(saved()?.textContent).toBe("Saved");
    expect(host.querySelectorAll('label [role="status"]')).toHaveLength(1);
  });

  it("hides an earlier mark immediately when typing resumes and never marks a failed save", async () => {
    await start();
    await edit();
    await tick(400);
    await land();
    expect(saved()).not.toBeNull();
    await edit();
    expect(saved()).toBeNull();
    await tick(400);
    await act(async () => { requests.at(-1)!.reject(); });
    expect(saved()).toBeNull();
    await tick(2500);
    expect(saved()).toBeNull();
  });

  it("does not mark Name or Title saves", async () => {
    await start();
    await act(async () => { queue.enqueue(value().id, { name: "Changed", title: "Changed" }, value()); });
    await tick(400);
    await land();
    expect(saved()).toBeNull();
    expect(host.querySelectorAll('label [role="status"]')).toHaveLength(1);
  });

  it("coalesces a typing burst without showing intermediate marks", async () => {
    await start();
    for (let key = 0; key < 8; key += 1) {
      await edit();
      await tick(50);
      expect(saved()).toBeNull();
    }
    await tick(349);
    expect(requests).toHaveLength(0);
    await tick(1);
    expect(requests).toHaveLength(1);
    await land();
    expect(saved()?.textContent).toBe("Saved");
  });

  it("keeps a newer save pending when the earlier request fails", async () => {
    await start();
    await edit();
    await tick(400);
    await edit();
    await tick(400);
    await act(async () => { requests[0].reject(); });
    expect(saved()).toBeNull();
    await land();
    expect(saved()?.textContent).toBe("Saved");
  });

  it("does not mark a cancelled request when its response arrives", async () => {
    await start();
    await edit();
    await tick(400);
    await act(async () => { queue.cancel(value().id); });
    await land();
    expect(saved()).toBeNull();
  });

  it("removes the mark without an exit delay with reduced motion", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("prefers-reduced-motion") } as MediaQueryList));
    await start();
    await edit();
    await tick(400);
    await land();
    expect(saved()?.className).toContain("motion-reduce:animate-none");
    await tick(2000);
    expect(saved()).toBeNull();
  });
});
