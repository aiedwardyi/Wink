import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { catalogs } from "@/lib/i18n-catalog";
import { saveModelPickerView } from "@/lib/model-picker-view";
import { savePickerLook } from "@/lib/picker-look";
import { saveRainbowBox } from "@/lib/rainbow-box";
import { SKINS } from "@/lib/skins";
import { saveTerminalPopups, terminalPopupsEnabled } from "@/lib/terminal-popups";
import type { AppSettingsSection } from "@/state/store";

const mock = vi.hoisted(() => ({
  section: "general" as AppSettingsSection,
  updaterState: null as unknown,
  dial: false,
}));

// keep the real useManualCheck: SettingsModal imports it from here too, and
// a mock exporting only useUpdaterState throws at render
vi.mock("@/lib/updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/updater")>()),
  useUpdaterState: () => mock.updaterState,
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", {
    value: { ogb: undefined },
    configurable: true,
    writable: true,
  });
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: {
        appSettingsOpen: true,
        appSettingsSection: mock.section,
        appSettingsPage: true,
        bots: [],
        config: {
          composio: { configured: false },
          gemini: { configured: false },
          box: { configured: false },
          vps: { configured: false, sshAlias: "" },
          rooms: { turnTimeoutMinutes: 5 },
          localVm: { mode: "shared", maxInstances: 1 },
          profile: { name: "", email: "" },
          features: { showToolCalls: false, modelDial: mock.dial },
        },
      },
      dispatch: () => undefined,
    }),
  };
});

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: {
      host: { platform: "win32", packaged: true, homeDir: undefined },
      toasts: { available: false },
      localComputer: { available: false, support: "unsupported" },
    },
    ready: true,
  }),
}));

vi.mock("./CompanionSection", () => ({
  CompanionSection: () => {
    throw new Error("companion must stay parked");
  },
}));

vi.mock("./EnginesSettings", () => ({
  EnginesSettings: () => null,
}));

vi.mock("./UsageSection", () => ({
  UsageSection: () => null,
}));

import { SettingsModal } from "./SettingsModal";

const here = dirname(fileURLToPath(import.meta.url));

function markup(
  section: AppSettingsSection = "general",
  defaultAdvancedOpen = false,
) {
  mock.section = section;
  return renderToStaticMarkup(
    createElement(SettingsModal, { defaultAdvancedOpen }),
  );
}

describe("SettingsModal friends chrome", () => {
  it("keeps the same dialog height on Devices", () => {
    vi.stubGlobal("location", { hostname: "localhost" });
    const dialogClass = (html: string) => html.match(/role="dialog"[^>]*class="([^"]+)"/)?.[1];
    expect(dialogClass(markup("companion"))).toBe(dialogClass(markup("general")));
    vi.unstubAllGlobals();
  });

  beforeAll(() => {
    if (typeof document === "undefined") {
      Object.defineProperty(globalThis, "document", {
        value: { documentElement: { lang: "en", dataset: {} } },
        configurable: true,
      });
    }
  });

  it("keeps General short with Advanced closed and parked controls hidden", () => {
    const html = markup("general");
    expect(html).not.toContain("Profile");
    expect(html).not.toContain("Skin");
    expect(html).not.toContain("Applies instantly and is remembered");
    expect(html).not.toContain("Work Steps");
    expect(html).not.toContain("Longer Replies");
    expect(html).not.toContain("Terminal Alerts");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("data-settings-preferences");
    expect(html).toContain(">Auto<");
    expect(html).not.toContain("Uses English or Korean from the operating system.");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("Reply Style");
    expect(html).not.toContain("Bot List Side");
    expect(html).toContain("English");
    expect(html).toContain("한국어");
    expect(html).not.toContain("Your name");
    expect(html).not.toContain("you@example.com");
    expect(html).not.toContain("Usage analytics");
    expect(html).not.toContain("Save name and email");
    expect(html).not.toContain("Save Name");
    expect(html).toContain("Advanced");
    expect(html).not.toContain("data-settings-advanced");
    expect(html).not.toContain('aria-label="Search Settings"');
    expect(html).not.toMatch(/>Channel turns</);
    expect(html).not.toContain("Set one maximum duration");
    expect(html).not.toContain("Maximum Turn Length");
    expect(html).not.toMatch(/>Experimental features</);
    expect(html).not.toContain("Teach a Skill");
    expect(html).not.toMatch(/>Diagnostics</);
    expect(html).not.toContain("Export Diagnostics");
    expect(html).not.toContain("Show Local VM Setup");
    expect(html).not.toContain("Cua Linux");
    expect(html).not.toContain("Hide Local VM Setup");
    expect(html).not.toMatch(/>Local VM</);
    expect(html).toMatch(/>Devices</);
    expect(html).not.toContain("OpenMausBot");
    expect(html).not.toContain("accounts.openmausbot.com");
    expect(html).not.toContain("Browser profiles");
    expect(html).not.toContain("Named sign-in sessions");
  });

  it("does not ship the Browser profiles setting", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    expect(source).not.toContain("BrowserProfilesRow");
    expect(source).not.toContain("settings.browserProfiles.title");
  });

  it("shows featured palettes with the remaining themes folded", () => {
    const html = markup("themes");
    expect(html).not.toContain(">Skin<");
    expect(html).not.toContain("Applies instantly and is remembered");
    for (const name of ["Precision", "GitHub Dimmed", "Tokyo Night", "Terminal", "Inkwell", "Graphite", "Precision Dimmed", "Bronze", "Dim Sand", "Wink Day", "Notebook"]) {
      expect(html).toContain(`>${name}<`);
    }
    expect(html).toContain(`More themes (${SKINS.length - 11})`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-skin="catppuccin-frappe"');
    expect(html).not.toContain('data-skin="servo-gray"');
  });

  it("orders Usage, then Devices, after Connections", () => {
    const html = markup("general");
    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    expect([...nav.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "Account", "General", "Connections", "Usage", "Devices", "Themes", "Model Index", "Shortcuts",
    ]);
  });

  it("keeps Alt+T and Alt+U as nav shortcuts without hint text or a name tooltip", () => {
    const html = markup("themes");
    expect(html).not.toContain(">Alt+T<");
    expect(html).not.toContain(">Alt+U<");
    expect(html).not.toContain('title="Themes"');
    expect(html).toContain('aria-label="Themes"');
    expect(html).toContain('aria-keyshortcuts="Alt+T"');
    expect(html).toContain('aria-keyshortcuts="Alt+U"');
  });

  it("places Model index right after Usage with its shortcuts", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const block = source.slice(source.indexOf("const SECTIONS"), source.indexOf("];", source.indexOf("const SECTIONS")));
    expect(block.indexOf('id: "models-index"')).toBeGreaterThan(block.indexOf('id: "usage"'));    const html = markup("models-index");
    expect(html).toContain('aria-keyshortcuts="Alt+I"');
    expect(html).not.toContain("Ctrl+Shift+M");
    expect(html).toContain("Checked ");
  });

  it("keeps Start Fresh inside Advanced", () => {
    Object.defineProperty(window, "ogb", { value: { startFresh: vi.fn() }, configurable: true, writable: true });
    expect(markup("general")).not.toContain("Start Fresh");
    expect(markup("general", true)).toContain("Start Fresh");
    Object.defineProperty(window, "ogb", { value: undefined, configurable: true, writable: true });
  });

  it("keeps Skin out of General and on its own Themes tab", () => {
    const general = markup("general");
    expect(general).not.toContain("Skin");
    expect(general).not.toContain("Applies instantly and is remembered");
    expect(general).not.toContain('data-skin="inkwell"');
    const themes = markup("themes");
    expect(themes).not.toContain(">Skin<");
    expect(themes).toContain('data-skin="inkwell"');
  });

  it("hides terminal controls without changing saved alerts", () => {
    saveTerminalPopups(true);
    const html = markup("general", true);
    expect(html).not.toContain("Terminal Alerts");
    expect(html).not.toContain("Terminal Colors");
    expect(terminalPopupsEnabled()).toBe(true);
    saveTerminalPopups(false);
  });

  it("keeps one combined privacy switch on General and hides separate usage stats", () => {
    Object.defineProperty(window, "ogb", { value: { errorReportConsent: vi.fn(), setErrorReportConsent: vi.fn() }, configurable: true, writable: true });
    const html = markup("general");
    expect(html).toContain('aria-label="Crash reports and stats"');
    expect(html).toContain("Anonymous. No chats or files.");
    expect(html).not.toContain("Send Anonymous Usage Stats");
    expect((html.match(/role="switch"/g) ?? [])).toHaveLength(1);
    Object.defineProperty(window, "ogb", { value: undefined, configurable: true, writable: true });
  });

  it("groups Advanced preferences in one card without repeated titles", () => {
    const html = markup("general", true);
    const advanced = html.slice(html.indexOf("data-settings-preferences"));
    expect((advanced.match(/bg-card/g) ?? [])).toHaveLength(1);
    expect(advanced).not.toContain(">Tool Calls<");
    expect(advanced).not.toContain(">Replies<");
    for (const label of ["Bot List Side", "Reply Style", "Work Steps", "Longer Replies"]) {
      expect(advanced).toContain(`aria-label="${label}"`);
    }
  });

  it("picks the chat box ring from Off, Rainbow and Theme colors on Themes, off by default", () => {
    expect(markup("general")).not.toContain('aria-label="Chat Box"');
    const checked = () => [...markup("themes").matchAll(/<button type="button" role="radio" aria-checked="true"[^>]*>([^<]+)</g)].map((m) => m[1]);
    const group = markup("themes").match(/<div role="radiogroup" aria-label="Chat Box"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    expect([...group.matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Off", "Rainbow", "Theme Colors"]);
    expect(checked()).toContain("Off");
    saveRainbowBox("rainbow");
    expect(checked()).toContain("Rainbow");
    saveRainbowBox("theme");
    expect(checked()).toContain("Theme Colors");
    saveRainbowBox("off");
    expect(checked()).toContain("Off");
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    expect(source).toContain("onChange={saveRainbowBox}");
  });

  it("picks the model picker look from Dark, Light and Atelier under Chat Box, following the skin until picked", () => {
    const html = markup("themes");
    expect(html.indexOf('aria-label="Model Picker"')).toBeGreaterThan(html.indexOf('aria-label="Chat Box"'));
    const group = () => markup("themes").match(/<div role="radiogroup" aria-label="Model Picker"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    const checked = () => group().match(/aria-checked="true"[^>]*>([^<]+)</)?.[1];
    expect([...group().matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Dark", "Light", "Atelier"]);
    const dataset = document.documentElement.dataset;
    try {
      for (const [skin, look] of [["precision", "Dark"], ["wink-day", "Light"], ["atelier", "Atelier"]]) {
        dataset.skin = skin;
        expect(checked(), skin).toBe(look);
      }
      savePickerLook("dark");
      expect(checked()).toBe("Dark");
      dataset.skin = "precision";
      savePickerLook("atelier");
      expect(checked()).toBe("Atelier");
    } finally {
      delete dataset.skin;
    }
    expect(readFileSync(join(here, "SettingsModal.tsx"), "utf8")).toContain("onChange={savePickerLook}");
    expect([catalogs.ko["settings.pickerLook.title"], catalogs.ko["settings.pickerLook.dark"], catalogs.ko["settings.pickerLook.light"]]).toEqual(["모델 선택", "다크", "라이트"]);
  });

  it("picks the model picker style from Dial and List under the look row, wherever the dial can show", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const style = 'aria-label="Model Picker Style"';
    try {
      expect(markup("themes")).not.toContain(style);
      mock.dial = true;
      expect(markup("themes")).not.toContain(style);
      window.matchMedia = ((media: string) => ({ media, matches: true })) as typeof window.matchMedia;
      const html = markup("themes");
      expect(html.indexOf(style)).toBeGreaterThan(html.indexOf('aria-label="Model Picker"'));
      const group = () => markup("themes").match(/<div role="radiogroup" aria-label="Model Picker Style"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
      const checked = () => group().match(/aria-checked="true"[^>]*>([^<]+)</)?.[1];
      expect([...group().matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Dial", "List"]);
      expect(checked()).toBe("Dial");
      saveModelPickerView("list");
      expect(values.get("omb-model-picker-view")).toBe("list");
      expect(checked()).toBe("List");
    } finally {
      mock.dial = false;
      Reflect.deleteProperty(window, "matchMedia");
      vi.unstubAllGlobals();
    }
    expect(readFileSync(join(here, "SettingsModal.tsx"), "utf8")).toContain("onChange={saveModelPickerView}");
    expect([catalogs.ko["settings.pickerStyle.title"], catalogs.ko["settings.pickerStyle.dial"], catalogs.ko["settings.pickerStyle.list"]]).toEqual(["모델 선택 방식", "다이얼", "목록"]);
  });

  it("does not reveal Local VM, channel turns, experimental, or diagnostics when Advanced would have been open", () => {
    const html = markup("general", true);
    expect(html).not.toContain("data-settings-advanced");
    expect(html).toContain("Advanced");
    expect(html).not.toMatch(/>Channel turns</);
    expect(html).not.toContain("Set one maximum duration");
    expect(html).not.toMatch(/>Experimental features</);
    expect(html).not.toContain("Teach a Skill");
    expect(html).not.toMatch(/>Diagnostics</);
    expect(html).not.toContain("Export Diagnostics");
    expect(html).not.toMatch(/>Local VM</);
    expect(html).not.toContain("Cua Linux");
  });

  it("keeps Connections quiet without Gemini key or zoo services", () => {
    const html = markup("connections");
    expect(html).not.toContain("Gemini API Key");
    expect(html).not.toContain("Wink detects installed");
    expect(html).not.toContain("OpenCode API key");
    expect(html).not.toContain("More Services");
    expect(html).not.toContain("data-settings-more-services");
    expect(html).not.toContain("Box API Key");
    expect(html).not.toContain("AssemblyAI");
    expect(html).not.toContain("Self-Hosted VPS");
    expect(html).not.toContain("Composio Project Key");
    expect(html).not.toContain("Self-Host Connected Apps");
    expect(html).not.toContain("OpenMausBot");
    expect(html).not.toMatch(/>Engines</);
  });

  it("compresses Language into a segmented row and Profile into compact chrome", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const picker = readFileSync(join(here, "LanguagePicker.tsx"), "utf8");
    const profile = readFileSync(join(here, "ProfileFields.tsx"), "utf8");
    const primitives = readFileSync(join(here, "SettingsPrimitives.tsx"), "utf8");
    expect(picker).not.toContain("compact");
    expect(picker).not.toContain("flex-col gap-2");
    expect(picker).toContain("<SegmentedRow");
    expect(picker).toContain("language.matchSystem");
    expect(picker).toContain("language.name.en");
    expect(picker).toContain("language.name.ko");
    expect(picker).not.toContain("aria-describedby");
    expect(picker).not.toMatch(/title=\{id === "system"/);
    expect(source).not.toContain("compact");
    expect(profile).toContain("settings.profile.namePlaceholder");
    expect(profile).not.toContain("settings.profile.emailPlaceholder");
    expect(profile).toContain("settings.profile.save");
    expect(primitives).not.toContain("compact");
    const general = source.slice(source.indexOf('section === "general"'), source.indexOf('section === "connections"'));
    expect(general.indexOf("<LanguagePicker")).toBeGreaterThan(-1);
    expect(general.indexOf("<ToolCallsRow")).toBeGreaterThan(general.indexOf("<LanguagePicker"));
    expect(general).not.toContain("settings.skin.title");
    expect(general).not.toContain("<SkinPicker");
    const themes = source.slice(source.indexOf('section === "themes"'), source.indexOf('section === "engines"') === -1 ? undefined : source.indexOf('section === "engines"'));
    expect(themes).toContain("<SkinPicker");
    expect(themes).not.toContain("settings.skin.title");
  });

  it("orders General with Bot List Side and Reply Style first under Advanced", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const general = source.slice(source.indexOf('section === "general"'), source.indexOf('section === "connections"'));
    const order = ["<LanguagePicker", "<PhoneNotificationSettings", "<VibrationRow", "<UpdatesRow", "data-settings-preferences", "<SidebarSideRow", "<ReplyStyleRow", "<ToolCallsRow", "<DetailedRepliesRow", "<StartFreshRow"].map((marker) => general.indexOf(marker));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts phone notifications on General outside Advanced", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const row = source.slice(source.indexOf('section === "general"'), source.indexOf('section === "connections"'));
    expect(row).toContain("<PhoneNotificationSettings");
    expect(row.indexOf("<PhoneNotificationSettings")).toBeLessThan(row.indexOf("data-settings-preferences"));
    const connections = source.slice(source.indexOf('section === "connections"'), source.indexOf('{section === "themes" && (', source.indexOf('section === "connections"')));
    expect(connections).not.toContain("<PhoneLinkSettings");
    expect(connections).not.toContain("<PhoneAccessSettings");
    expect(connections).not.toContain("<PhoneNotificationSettings");
  });

  it("hides phone notifications in the desktop app", () => {
    const source = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    const row = source.slice(source.indexOf('section === "general"'), source.indexOf('section === "connections"'));
    expect(row).toContain("{!window.ogb && <Card><PhoneNotificationSettings /></Card>}");
  });

  it("shows Vibration only where a phone can vibrate", () => {
    const win = window as unknown as Record<string, unknown>;
    const matchMedia = (matches: boolean) => () => ({ matches });
    try {
      expect(markup("general")).not.toContain('aria-label="Vibration"');
      win.matchMedia = matchMedia(false);
      win.navigator = { vibrate: () => true };
      expect(markup("general")).not.toContain('aria-label="Vibration"');
      win.matchMedia = matchMedia(true);
      win.navigator = {};
      expect(markup("general")).not.toContain('aria-label="Vibration"');
      win.navigator = { vibrate: () => true };
      expect(markup("general")).toContain('aria-label="Vibration"');
    } finally {
      delete win.matchMedia;
      delete win.navigator;
    }
  });

  it("drops the on-this-device line from Sync", () => {
    expect(readFileSync(join(here, "SyncPanel.tsx"), "utf8")).not.toContain("settings.sync.localChats");
    expect(catalogs.en).not.toHaveProperty("settings.sync.localChats");
    expect(catalogs.ko).not.toHaveProperty("settings.sync.localChats");
  });

  it("labels Soft and Boxy as Corners with a tooltip", () => {
    expect(markup("themes")).toContain('title="Corners"');
  });

  it("splits featured skins into Dark then Light groups", () => {
    const html = markup("themes");
    const dark = html.lastIndexOf(">Dark<");
    const light = html.lastIndexOf(">Light<");
    expect(dark).toBeGreaterThan(-1);
    expect(light).toBeGreaterThan(dark);
    const ids = (part: string) => [...part.matchAll(/data-skin="([a-z-]+)"/g)].map(([, id]) => id);
    expect(ids(html.slice(dark, light))).toEqual(["precision", "github-dimmed", "tokyo-night", "terminal", "inkwell", "graphite", "precision-dimmed", "bronze"]);
    expect(ids(html.slice(light))).toEqual(["dim-sand", "wink-day", "notebook"]);
    expect(ids(html)).toHaveLength(11);
  });




});

describe("friends settings chrome has no OpenMausBot docs", () => {
  it("strips OpenMausBot-named help links from settings chrome", () => {
    const apiKeys = readFileSync(join(here, "ApiKeys.tsx"), "utf8");
    const settings = readFileSync(join(here, "SettingsModal.tsx"), "utf8");
    for (const source of [apiKeys, settings]) {
      expect(source).not.toContain("OpenMausBot");
      expect(source).not.toContain("openmausbot");
      expect(source).not.toContain("milind-soni");
    }
  });
});

describe("updater missing app-update.yml fallback", () => {
  it("shows friendly fallback message when app-update.yml is missing (ENOENT)", () => {
    Object.defineProperty(window, "ogb", {
      value: { updater: { check: vi.fn(), download: vi.fn(), install: vi.fn() } },
      configurable: true,
      writable: true,
    });
    mock.updaterState = {
      status: "error",
      message: "Error: ENOENT: no such file or directory, open 'C:\\resources\\app-update.yml'",
    };
    const html = markup("general");
    expect(html.replace(/&#x27;/g, "'")).toContain("Updates aren't available in this build");
    expect(html).not.toContain("ENOENT");
    expect(html).not.toContain("app-update.yml");
  });
});

describe("updates card on the phone remote view", () => {
  it("renders from the proxied state without the preload bridge", () => {
    Object.defineProperty(window, "ogb", { value: undefined, configurable: true, writable: true });
    mock.updaterState = { status: "installing", appVersion: "1.0.52" };
    const html = markup("general");
    expect(html).toContain("Restarting to update");
    expect(html).toContain("v1.0.52");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check for Updates/);
  });

  it("stays hidden when the desktop updater is unavailable", () => {
    Object.defineProperty(window, "ogb", { value: undefined, configurable: true, writable: true });
    mock.updaterState = null;
    expect(markup("general")).not.toContain("Check for Updates");
  });
});
