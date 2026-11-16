import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkinId } from "./skins";

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

describe("model picker look picked in the picker", () => {
  const storage = () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    return values;
  };

  it("lists Theme first and starts on it", async () => {
    storage();
    const { PICKER_LOOK_CHOICES, pickedLook, shownPickerLook } = await import("./picker-look");
    expect(PICKER_LOOK_CHOICES).toEqual(["theme", "dark", "light", "atelier"]);
    expect(pickedLook()).toBe("theme");
    const skins: SkinId[] = ["precision", "wink-day", "atelier"];
    expect(skins.map((skin) => shownPickerLook("theme", skin))).toEqual(["dark", "light", "atelier"]);
  });

  it("keeps a picked look over every theme until Theme is picked again", async () => {
    const values = storage();
    const { pickedLook, savePickerLook, shownPickerLook } = await import("./picker-look");
    savePickerLook("light");
    expect(pickedLook()).toBe("light");
    const skins: SkinId[] = ["precision", "atelier", "wink-day"];
    expect(skins.map((skin) => shownPickerLook(pickedLook(), skin))).toEqual(["light", "light", "light"]);
    expect(values.get("omb-model-picker-look")).toBe("light");
    vi.resetModules();
    expect((await import("./picker-look")).pickedLook()).toBe("light");
    (await import("./picker-look")).savePickerLook("theme");
    expect(values.has("omb-model-picker-look")).toBe(false);
    expect((await import("./picker-look")).pickedLook()).toBe("theme");
  });

  it("keeps the pick for the session when storage is blocked", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    const { pickedLook, savePickerLook } = await import("./picker-look");
    expect(() => savePickerLook("atelier")).not.toThrow();
    expect(pickedLook()).toBe("atelier");
    expect(() => savePickerLook("theme")).not.toThrow();
    expect(pickedLook()).toBe("theme");
  });
});
