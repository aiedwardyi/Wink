import { describe, expect, it } from "vitest";

import { initialState, reducer } from "./store";

describe("app settings open on General", () => {
  it("returns the gear to General after a shortcut tab", () => {
    const onUsage = reducer(initialState, { type: "toggleAppSettings", open: true, section: "usage" });
    const closed = reducer(onUsage, { type: "toggleAppSettings", open: false });
    const fromGear = reducer(closed, { type: "toggleAppSettings" });
    expect(fromGear.appSettingsOpen).toBe(true);
    expect(fromGear.appSettingsSection).toBe("general");
    expect(fromGear.appSettingsPage).toBe(false);
  });

  it("still opens the tab a shortcut names", () => {
    const onThemes = reducer(initialState, { type: "toggleAppSettings", open: true, section: "themes" });
    const usage = reducer(onThemes, { type: "toggleAppSettings", open: true, section: "usage" });
    const models = reducer(usage, { type: "toggleAppSettings", open: true, section: "models-index" });
    expect(usage.appSettingsSection).toBe("usage");
    expect(models.appSettingsSection).toBe("models-index");
    expect(usage.appSettingsPage).toBe(true);
    expect(models.appSettingsPage).toBe(true);
  });

  it.each(["general", "connections", "usage"] as const)("distinguishes an explicit %s link from the gear", (section) => {
    const linked = reducer(initialState, { type: "toggleAppSettings", open: true, section });
    expect(linked.appSettingsSection).toBe(section);
    expect(linked.appSettingsPage).toBe(true);
    const list = reducer(linked, { type: "toggleAppSettings", open: true });
    expect(list.appSettingsOpen).toBe(true);
    expect(list.appSettingsPage).toBe(false);
  });
});

describe("memory settings target", () => {
  it("increments on every tap, including the same open target", () => {
    const action = { type: "toggleSettings", open: true, memory: { line: "- Seoul" } } as const;
    const first = reducer(initialState, action);
    const second = reducer(first, action);
    expect(first.settingsMemoryTarget?.target).toEqual(action.memory);
    expect(second.settingsMemoryTarget?.nonce).toBe(first.settingsMemoryTarget!.nonce + 1);
    const closed = reducer(second, { type: "toggleSettings", open: false });
    expect(closed.settingsMemoryTarget).toBeNull();
    expect(reducer(closed, action).settingsMemoryTarget!.nonce).toBeGreaterThan(second.settingsMemoryTarget!.nonce);
  });
});

describe("deleting the open room", () => {
  it("closes Room details instead of opening the next bot's details", () => {
    const group = { id: "g1", threadId: "t1", name: "Room", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 0, messages: [] } as const;
    const bot = { id: "b1", threadId: "bt1", name: "Wink", title: "", description: "", notifications: true, color: "green", unread: false, messages: [] } as const;
    const open = { ...initialState, bots: [bot], groups: [group], selectedId: "g1", settingsOpen: true } as unknown as typeof initialState;
    const after = reducer(open, { type: "groupDeleted", groupId: "g1" });
    expect(after.selectedId).toBe("b1");
    expect(after.settingsOpen).toBe(false);
  });
});
