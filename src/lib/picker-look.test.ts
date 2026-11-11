import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("model picker look preference", () => {
  it.each([
    ["precision", "dark"],
    ["mono-hud", "dark"],
    ["wink-day", "light"],
    ["notebook", "light"],
    ["atelier", "atelier"],
  ] as const)("follows the %s skin as %s until picked", async (skin, look) => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const { pickerLook } = await import("./picker-look");
    expect(pickerLook(skin)).toBe(look);
  });

  it("keeps the pick on every skin after a module reload", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    (await import("./picker-look")).savePickerLook("dark");
    expect(values.get("omb-picker-look")).toBe("dark");
    vi.resetModules();
    const { pickerLook } = await import("./picker-look");
    expect(["atelier", "wink-day", "precision"].map((skin) => pickerLook(skin as "atelier"))).toEqual(["dark", "dark", "dark"]);
  });

  it("ignores an unknown stored value and keeps the pick when storage throws", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "neon" });
    expect((await import("./picker-look")).pickerLook("atelier")).toBe("atelier");
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    const { pickerLook, savePickerLook } = await import("./picker-look");
    expect(pickerLook("precision")).toBe("dark");
    savePickerLook("light");
    expect(pickerLook("precision")).toBe("light");
  });
});
