import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelPickerView, nextPickerStyle, saveModelPickerView } from "./model-picker-view";

afterEach(() => vi.unstubAllGlobals());

describe("model picker view", () => {
  it("defaults to the dial for missing and invalid preferences", () => {
    for (const value of [null, "unknown", "dial"]) {
      vi.stubGlobal("localStorage", { getItem: () => value });
      expect(loadModelPickerView()).toBe("dial");
    }
  });

  it("loads the last view from storage without a store instance", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    saveModelPickerView("list");
    expect(loadModelPickerView()).toBe("list");
    saveModelPickerView("dial");
    expect(loadModelPickerView()).toBe("dial");
  });

  it("tolerates unavailable storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(loadModelPickerView()).toBe("dial");
    expect(() => saveModelPickerView("list")).not.toThrow();
    expect(loadModelPickerView()).toBe("list");
  });
});

describe("model picker style rotation", () => {
  it("steps to the next style and wraps", () => {
    const styles = ["dial", "list", "chart", "machine"] as const;
    expect(styles.map((style) => nextPickerStyle(styles, style))).toEqual(["list", "chart", "machine", "dial"]);
  });

  it("starts from the first style when the shown one is not offered", () => {
    expect(nextPickerStyle(["list", "machine"], "dial")).toBe("list");
  });

  it("remembers the Machine as a style", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    saveModelPickerView("machine");
    expect(loadModelPickerView()).toBe("machine");
  });
});
