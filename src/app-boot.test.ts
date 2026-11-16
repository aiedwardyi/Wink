import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "App.tsx"), "utf8");

describe("first-chat boot keeps off-screen panels out of the initial module graph", () => {
  it("lazy-loads settings, plugins, and other secondary surfaces", () => {
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/SettingsPanel"\)/);
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/SettingsModal"\)/);
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/PluginsPanel"\)/);
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/InspectorPanel"\)/);
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/CommandPalette"\)/);
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/CreateBotSheet"\)/);
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/Onboarding"\)/);
    expect(app).toMatch(/lazyView\(\(\) => import\("@\/components\/NoEngines"\)/);
    expect(app).not.toMatch(/= lazy\(/);
    expect(app).not.toMatch(/^import \{ SettingsPanel/m);
    expect(app).not.toMatch(/^import \{ CommandPalette/m);
  });

  it("still mounts chat chrome eagerly", () => {
    expect(app).toMatch(/^import \{ Sidebar \} from "@\/components\/Sidebar";/m);
    expect(app).toMatch(/^import \{ ChatView(, \w+)* \} from "@\/components\/ChatView";/m);
    expect(app).toContain("<LazyView");
  });

  it("does not start the engine describe on the first chat snapshot", () => {
    const store = readFileSync(join(here, "state/store.tsx"), "utf8");
    expect(store).toMatch(/firstChatPeripherals/);
    expect(store).toMatch(/scheduleDeferredInstancesLoad/);
    expect(store).toMatch(/partByKey\.get\("instances"\)/);
  });

  it("warms lazy screens in every window once the first chat is up", () => {
    const warmed = app.match(/useEffect\(\(\) => \{\s*if \(state\.hydrated\) return warmViews\(\[([^\]]*)\]\);\s*\}, \[state\.hydrated\]\);/)?.[1].split(", ");
    expect(warmed).toEqual([
      "SettingsPanel.preload", "SettingsModal.preload", "CreateBotSheet.preload", "ShowPane.preload", "warmCallSlots", "warmCallViews", "RoomDetailsPanel.preload",
    ]);
  });

  it("fetches app settings on desktop before boot API calls can hold every connection", () => {
    expect(app).toMatch(/useEffect\(\(\) => \{\s*if \(window\.ogb\) void import\("@\/components\/SettingsModal"\)\.catch\(\(\) => \{\}\);\s*\}, \[\]\);/);
  });

  it("does not prefetch connected-apps on the first chat paint", () => {
    expect(app).toMatch(/preloadConnectedApps/);
    expect(app).toMatch(/requestIdleCallback/);
    expect(app).toMatch(/timeout:\s*800/);
    expect(app).toMatch(/PluginsPanel\.preload\(\)\s*\.then\(\(\) => import\("@\/components\/PluginsPanel"\)\)/);
  });

  it("isolates lazy overlays so one chunk cannot unmount the others", () => {
    expect(app).toMatch(/<CommandPalette onOpenChange=\{setPaletteOpen\} \/>/);
    expect(app).not.toMatch(/paletteReady/);
    expect(app).toMatch(/CreateBotSheet required=\{createBotRequired\} closing=\{closing\} \/>[\s\S]*?<\/LazyView>/);
    expect(app.match(/<LazyView overlay>/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe("update reload", () => {
  it("waits while a secondary view or sidebar flow is open", () => {
    const open = app.match(/const secondaryViewOpen =([\s\S]*?);/)?.[1] ?? "";
    for (const flag of ["onboardingOpen", "terminalOpen", "paletteOpen", "sidebarOverlay", "state.appSettingsOpen", "state.pluginsOpen", "createBotSheetOpen"]) {
      expect(open).toContain(flag);
    }
    expect(app).toContain("useStaleBuildReload(state.connected, secondaryViewOpen)");
  });
});
