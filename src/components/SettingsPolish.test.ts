// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";

const { mockState, mockApi } = vi.hoisted(() => {
  const claudeInstance: InstanceInfo = {
    instanceId: "claude",
    driverKind: "claudeAgent",
    displayName: "Claude",
    snapshot: { state: "available", authenticated: true },
    models: { default: "claude-3-5-sonnet", options: [] },
    capabilities: { rateLimits: true },
    rateLimits: {
      observedAt: new Date().toISOString(),
      windows: [],
    },
  };
  const codexInstance: InstanceInfo = {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    snapshot: { state: "available", authenticated: true },
    models: { default: "o3-mini", options: [] },
    capabilities: { rateLimits: true },
  };
  const grokInstance: InstanceInfo = {
    instanceId: "grok",
    driverKind: "grokAgent",
    displayName: "Grok",
    snapshot: { state: "available", authenticated: true },
    models: { default: "grok-4", options: [] },
    capabilities: { rateLimits: true },
  };
  const antigravityInstance: InstanceInfo = {
    instanceId: "antigravity",
    driverKind: "antigravityAgent",
    displayName: "Antigravity",
    snapshot: { state: "available", authenticated: true },
    models: { default: "gemini-2.5", options: [] },
    capabilities: { rateLimits: false },
  };
  return {
    mockApi: vi.fn(async (_path: string, _options?: RequestInit): Promise<{ report?: { windows: { id: string; usedPercent: number }[]; observedAt: string }; error?: string }> => ({})),
    mockState: {
      appSettingsOpen: true,
      appSettingsSection: "connections",
      bots: [] as Bot[],
      instances: [claudeInstance],
      config: {
        composio: { configured: false, mode: "local" },
        gemini: { configured: false },
        box: { configured: false },
        vps: { configured: false, sshAlias: "" },
        rooms: { turnTimeoutMinutes: 5 },
        localVm: { mode: "shared", maxInstances: 1 },
        profile: { name: "", email: "" },
        features: { showToolCalls: false },
      },
      mascotMotion: null,
    },
    claudeInstance,
    codexInstance,
    grokInstance,
    antigravityInstance,
  };
});

vi.mock("@/lib/usage-auto-refresh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/usage-auto-refresh")>()),
  useAutoRefresh: () => undefined,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: (path: string, init?: RequestInit) => path === "/api/accounts" ? Promise.resolve({ accounts: [] }) : mockApi(path, init),
    useStore: () => ({
      state: mockState,
      dispatch: () => undefined,
      refreshInstances: async () => undefined,
    }),
  };
});

vi.mock("@/lib/updater", () => ({
  useUpdaterState: () => null,
  useManualCheck: () => ({ acknowledged: true, check: () => {} }),
}));

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", homeDir: "/home/user" },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

vi.mock("./EnginesSettings", () => ({
  EnginesSettings: () => null,
}));

vi.mock("./VoiceSettings", () => ({
  VoiceSettings: () => null,
}));

vi.mock("./BotProfileAvatarCard", () => ({
  BotProfileAvatarCard: () => null,
}));

vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: () => null,
}));


import { UsageSection } from "./UsageSection";
import { SettingsModal } from "./SettingsModal";
import { SettingsPanel } from "./SettingsPanel";

describe("Settings Polish", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (window as any).ogb = {
      pickFolder: vi.fn(),
    };
  });

  afterEach(() => {
    root.unmount();
    host.remove();
  });

  it.each(["en", "ko"])("caps Name on desktop and keeps Language flush right like every row in %s", async (locale) => {
    const previousLocale = localStorage.getItem("omb-locale");
    localStorage.setItem("omb-locale", locale);
    try {
      mockState.appSettingsSection = "account";
      await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal))));
      const name = host.querySelector<HTMLInputElement>("#settings-profile-name")!;
      expect.soft(name.className).toContain("w-full md:max-w-xs");

      mockState.appSettingsSection = "general";
      await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal))));
      const language = host.querySelector('[role="radiogroup"]')!;
      expect(language.closest(".md\\:max-w-md")).toBeNull();
      expect(language.className).toContain("w-fit");
      expect(language.parentElement?.className).toContain("[&>[role=radiogroup]]:ml-auto");
    } finally {
      if (previousLocale === null) localStorage.removeItem("omb-locale");
      else localStorage.setItem("omb-locale", previousLocale);
    }
  });

  it.each(["Bot List Side", "Reply Style"])("sizes %s to its labels in a wrapping shared row", async (label) => {
    mockState.appSettingsSection = "general";
    await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal, { defaultAdvancedOpen: true }))));
    const group = host.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
    expect(group.className).toContain("w-fit");
    expect(group.parentElement?.className).toContain("flex-wrap");
    expect(group.parentElement?.className).toContain("[&>[role=radiogroup]]:ml-auto");
    expect(group.querySelector("button")?.className).not.toContain("flex-1");
  });

  it("puts Chat Box beside the same compact control and allows natural wrapping", async () => {
    mockState.appSettingsSection = "themes";
    await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal))));
    const group = host.querySelector('[role="radiogroup"][aria-label="Chat Box"]')!;
    expect(group.className).toContain("w-fit");
    expect(group.parentElement?.className).toContain("flex-wrap");
    expect(group.previousElementSibling?.textContent).toContain("Chat Box");
    expect(group.previousElementSibling?.className).toContain("min-w-[min(100%,12rem)]");
    expect(group.querySelector("button")?.className).not.toContain("flex-1");
  });

  it("Usage has no Refresh All or per-engine Refresh button", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UsageSection)));
    });
    const labels = [...host.querySelectorAll("button")].map((b) => `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`);
    expect(labels.filter((label) => /Refresh/.test(label))).toEqual([]);
    expect(host.querySelector('[aria-keyshortcuts="Alt+R"]')).toBeNull();
  });

  it("saves Longer replies through the shared config inside Advanced", async () => {
    const previousSection = mockState.appSettingsSection;
    mockState.appSettingsSection = "general";
    mockApi.mockClear();
    try {
      await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal, { defaultAdvancedOpen: true }))));
      const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Longer Replies"]');
      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      await act(async () => toggle?.click());
      expect(mockApi).toHaveBeenCalledWith("/api/config", {
        method: "PATCH", body: JSON.stringify({ features: { detailedReplies: true } }),
      });
    } finally {
      mockState.appSettingsSection = previousSection;
    }
  });

  it("defaults Reply style to Live Typing on this device", async () => {
    mockState.appSettingsSection = "general";
    localStorage.removeItem("omb-reply-style");
    await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal, { defaultAdvancedOpen: true }))));
    const choice = host.querySelector('[role="radiogroup"][aria-label="Reply Style"] [role="radio"][aria-checked="true"]');
    expect(choice?.textContent).toBe("Live Typing");
  });

  it("saves Reply style locally and restores it when settings reopen", async () => {
    mockState.appSettingsSection = "general";
    localStorage.removeItem("omb-reply-style");
    mockApi.mockClear();
    await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal, { defaultAdvancedOpen: true }))));
    const live = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent === "Live Typing");
    mockApi.mockClear();
    await act(async () => live?.click());
    expect(localStorage.getItem("omb-reply-style")).toBe("live");
    expect(mockApi).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsModal, { defaultAdvancedOpen: true }))));
    expect(host.querySelector('[role="radiogroup"][aria-label="Reply Style"] [aria-checked="true"]')?.textContent).toBe("Live Typing");
    localStorage.removeItem("omb-reply-style");
  });

  it("the Connections pane shows \"Connections\" exactly once", async () => {
    mockState.appSettingsSection = "connections";
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsModal)));
    });

    const pane = host.querySelector(".flex.min-w-0.flex-1.flex-col");
    expect(pane).toBeTruthy();
    const connectionsLabels = [...(pane?.querySelectorAll("*") ?? [])].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === "Connections",
    );
    expect(connectionsLabels).toHaveLength(1);
  });

  it("reads the folder in the row font, empty or set", async () => {
    const emptyBot: Bot = {
      id: "bot-empty",
      threadId: "t1",
      name: "Empty Bot",
      title: "",
      description: "",
      notifications: false,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" },
      messages: [],
      cwd: null,
    };
    const memory = { text: "", truncated: false, topics: [] } as never;
    mockApi.mockResolvedValueOnce(memory).mockResolvedValueOnce(memory);

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: emptyBot })));
    });

    const emptySpan = [...host.querySelectorAll("span")].find(
      (s) => s.textContent?.trim() === "Private bot workspace",
    );
    expect(emptySpan).toBeDefined();
    expect(emptySpan?.parentElement?.className).toContain("text-[13px]");
    expect(emptySpan?.parentElement?.className).not.toContain("font-mono");

    // Re-render with real path
    const populatedBot: Bot = {
      ...emptyBot,
      id: "bot-populated",
      cwd: "/home/user/my-project",
    };

    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: populatedBot })));
    });

    const populatedBox = host.querySelector('[title="/home/user/my-project"]');
    expect(populatedBox).toBeTruthy();
    expect(populatedBox?.className).toContain("text-[13px]");
    expect(populatedBox?.className).not.toContain("font-mono");
    expect(populatedBox?.textContent).toContain("my-project");
  });
});
