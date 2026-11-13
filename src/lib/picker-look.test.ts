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
  ] as const)("follows the %s skin as %s", async (skin, look) => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const { pickerLook } = await import("./picker-look");
    expect(pickerLook(skin)).toBe(look);
  });

  it("ignores a look saved before the picker followed the theme", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "dark" });
    const { pickerLook } = await import("./picker-look");
    expect(["wink-day", "atelier", "precision"].map((skin) => pickerLook(skin as "atelier"))).toEqual(["light", "atelier", "dark"]);
  });
});
