import { describe, expect, it } from "vitest";

import {
  friendsSettingsNavVisible,
  resolvedAppSettingsSection,
} from "./settings-chrome";

describe("friendsSettingsNavVisible", () => {
  it("hides phone setup on phones", () => {
    expect(friendsSettingsNavVisible("companion", { phoneAvailable: false })).toBe(false);
    expect(friendsSettingsNavVisible("general", { phoneAvailable: false })).toBe(true);
    expect(friendsSettingsNavVisible("connections", { phoneAvailable: false })).toBe(true);
    expect(friendsSettingsNavVisible("themes", { phoneAvailable: false })).toBe(true);
    expect(friendsSettingsNavVisible("usage", { phoneAvailable: false })).toBe(true);
  });

  it("shows Phone on the PC", () => {
    expect(friendsSettingsNavVisible("companion", { phoneAvailable: true })).toBe(true);
  });
});

describe("resolvedAppSettingsSection", () => {
  it("folds Sync into Account and preserves Phone deep links", () => {
    expect(resolvedAppSettingsSection("sync")).toBe("account");
    expect(resolvedAppSettingsSection("companion")).toBe("companion");
  });
});
