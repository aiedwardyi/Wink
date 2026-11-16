import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  showBotVoiceAndStartupSettings,
  showChannelCallControl,
  showUsagePerBotTable,
  showSidebarPhone,
  showDisabledShareTerminal,
  showAvatarFormatsHint,
  showBotMenuCopy,
  showNewMenuExport,
  showPhoneDrawerCollapse,
  showTouchPickerLegend,
  showTerminalAlerts,
  showTerminalColors,
} from "./friends-chrome";

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, "../components");
const settingsPanel = readFileSync(join(components, "SettingsPanel.tsx"), "utf8");
const groupView = readFileSync(join(components, "GroupView.tsx"), "utf8");
const sidebar = readFileSync(join(components, "Sidebar.tsx"), "utf8");
const avatarCard = readFileSync(join(components, "BotProfileAvatarCard.tsx"), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from === -1 ? 0 : from + start.length);
  if (from < 0 || to < 0) {
    throw new Error(`missing source markers ${JSON.stringify(start)} .. ${JSON.stringify(end)}`);
  }
  return source.slice(from, to);
}

describe("friends chrome flags", () => {
  it("keeps voice, call, and parked extras off the idle surface", () => {
    expect(showBotVoiceAndStartupSettings()).toBe(false);
    expect(showChannelCallControl()).toBe(false);
    expect(showSidebarPhone()).toBe(false);
    expect(showUsagePerBotTable()).toBe(false);
    expect(showBotMenuCopy()).toBe(false);
    expect(showNewMenuExport()).toBe(false);
    expect(showPhoneDrawerCollapse()).toBe(false);
    expect(showTouchPickerLegend()).toBe(false);
    expect(showTerminalAlerts()).toBe(false);
    expect(showTerminalColors()).toBe(false);
  });
});

describe("friends chrome call sites keep the feature code", () => {

  it("keeps voice and startup settings gated", () => {
    expect(settingsPanel).toContain("showBotVoiceAndStartupSettings()");
    expect(settingsPanel).toContain("<VoiceSettings");
  });

  it("gates the Usage per-bot table instead of deleting it", () => {
    const usage = readFileSync(join(components, "UsageSection.tsx"), "utf8");
    expect(usage).toContain("showUsagePerBotTable()");
    expect(usage).toContain("Turns");
    expect(usage).toContain("Tokens");
    expect(usage).toContain("Cost");
  });

  it("gates channel call chrome without removing the component", () => {
    expect(groupView).toContain("showChannelCallControl()");
    expect(groupView).toContain("<GroupCallButton");
  });

  it("keeps phone setup parked and avatar upload, colors, and styles available", () => {
    expect(sidebar).toContain("showSidebarPhone()");
    expect(avatarCard).toContain('t("bot.uploadImage")');
    expect(avatarCard).toContain("MAUS_COLOR_NAMES");
    expect(avatarCard).toContain("BOT_AVATAR_PICKER_ORDER");
    expect(avatarCard).toContain("mascotStyle");
  });

  it("keeps a drag-resize handle, collapse control, and create menu", () => {
    expect(sidebar).toContain('t("chrome.collapseSidebar")');
    expect(sidebar).toContain('t("chrome.resizeSidebar")');
    expect(sidebar).toContain("data-sidebar-resize");
    const resizeHandle = sourceBetween(
      sidebar,
      "role=\"separator\"",
      "macOS owns inset traffic lights",
    );
    expect(resizeHandle).toContain("data-sidebar-resize");
    expect(resizeHandle).not.toMatch(/density !== "icons"/);
    expect(resizeHandle).toContain("tabIndex={0}");
    expect(resizeHandle).toContain("aria-valuenow={sidebarDisplayWidth}");
    expect(resizeHandle).toContain("aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}");
    expect(resizeHandle).toContain("aria-valuemax={SIDEBAR_MAX_WIDTH}");
    expect(resizeHandle).toContain('t("chrome.sidebarWidthPixels", { width: sidebarDisplayWidth })');
    expect(resizeHandle).toContain("onKeyDown={onSidebarResizeKeyDown}");
    expect(resizeHandle).toContain("onPointerUp={onSidebarResizeEnd}");
    expect(resizeHandle).toContain("onPointerCancel={onSidebarResizeCancel}");
    expect(resizeHandle).not.toMatch(/onPointerCancel=\{onSidebarResizeEnd\}/);
    const resizeEnd = sourceBetween(sidebar, "const onSidebarResizeEnd", "const onSidebarResizeCancel");
    expect(resizeEnd).toContain("releasePointerCapture");
    expect(resizeEnd).toContain("saveSidebarWidth");
    expect(resizeEnd).toContain("saveSidebarCollapsed");
    const resizeCancel = sourceBetween(sidebar, "const onSidebarResizeCancel", "const onSidebarResizeKeyDown");
    expect(resizeCancel).toContain("restoreSidebarDragWidth");
    expect(resizeCancel).toContain("start.width");
    expect(resizeCancel).toContain("start.collapsed");
    expect(resizeCancel).toContain("setResizing(false)");
    expect(resizeCancel).not.toContain("saveSidebarWidth");
    expect(resizeCancel).not.toContain("saveSidebarCollapsed");
    const resizeStart = sourceBetween(sidebar, "const onSidebarResizeStart", "const onSidebarResizeMove");
    expect(resizeStart).toContain("setPointerCapture");
    expect(resizeStart).toContain("fitSidebarWidth(sidebarWidthRef.current, viewportWidth, dockedAsideWidth)");
    expect(resizeStart).toContain("sidebarCollapsedRef.current ? sidebarWidthRef.current");
    const resizeKey = sourceBetween(sidebar, "const onSidebarResizeKeyDown", "useEffect(() => {");
    // arrows must move the width the separator shows, not the saved one behind it
    expect(resizeKey).toContain("fitSidebarWidth(sidebarWidthRef.current, viewportWidth, dockedAsideWidth)");
    expect(sidebar).toContain("dockedDetailsWidth(");
    expect(sidebar).toContain("snapSidebarDrag");
    expect(sidebar).toContain("stepSidebarLayout");
    expect(sidebar).toContain("loadSidebarCollapsed");
    expect(sidebar).toContain("saveSidebarWidth(next.width)");
    expect(sidebar).toContain("saveSidebarCollapsed(next.collapsed)");
    const searchChrome = sourceBetween(sidebar, "{/* Search */}", "{/* Bot list */}");
    expect(searchChrome).toContain('t("chrome.searchBotsAria")');
    expect(searchChrome).not.toMatch(/density === "icons" \? "hidden"/);
    expect(sidebar).toContain('t("chrome.newOrShare")');
    expect(sidebar).toContain('t("chrome.newBot")');
    expect(sidebar).toContain('t("chrome.newChannel")');
    const toggleCollapsed = sourceBetween(sidebar, "const toggleCollapsed", "Esc closes the drawer");
    expect(toggleCollapsed).toContain("sidebarCollapsed");
    expect(toggleCollapsed).toContain("applySidebarLayout");
    expect(toggleCollapsed).toContain("persistSidebarLayout");
  });

  it("keeps the channel folder on i18n keys and does not lock it to a per-task pin", () => {
    expect(groupView).toContain('t("room.workingFolder")');
    expect(groupView).toContain('t("room.workingFolderHelp")');
    expect(groupView).toContain('t("room.chooseSharedFolder")');
    expect(groupView).toContain('t("room.setupBody")');
    expect(groupView).not.toMatch(/Start a new task/);
    expect(groupView).not.toMatch(/Fixed for this task/);
  });
});

describe("declutter settings flags", () => {
  it("keeps avatar hints and disabled terminal sharing parked", () => {
    expect(showDisabledShareTerminal()).toBe(false);
    expect(showAvatarFormatsHint()).toBe(false);
    const read = (name: string) => readFileSync(join(components, name), "utf8");
    expect(settingsPanel).toContain("(!shareTerminalDisabled || showDisabledShareTerminal()) && (");
    expect(avatarCard).toContain("(showAvatarFormatsHint() || rejected) && ");
    expect(read("ProfileFields.tsx")).toContain("(showAvatarFormatsHint() || rejected) && ");
  });
});
