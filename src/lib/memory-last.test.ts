// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { lastMemory, MEMORY_LAST_KEY, MEMORY_LAST_MAX_CHARS, rememberMemory } from "./memory-last";

const shown = (text: string) => ({ text, truncated: false, topics: [{ name: "prefs.md", bytes: 3 }] });

afterEach(() => localStorage.clear());

describe("last memory read", () => {
  it("keeps the newest read per bot", () => {
    rememberMemory("a", shown("- one"));
    rememberMemory("b", shown("- two"));
    rememberMemory("a", shown("- three"));
    expect(lastMemory("a")).toEqual(shown("- three"));
    expect(lastMemory("b")).toEqual(shown("- two"));
    expect(lastMemory("c")).toBeNull();
  });

  it("drops the bots read longest ago once the budget is full", () => {
    const big = "x".repeat(MEMORY_LAST_MAX_CHARS / 3);
    for (const id of ["a", "b", "c"]) rememberMemory(id, shown(big));
    expect(lastMemory("a")).toBeNull();
    expect(lastMemory("b")?.text).toBe(big);
    expect(lastMemory("c")?.text).toBe(big);
    expect(localStorage.getItem(MEMORY_LAST_KEY)!.length).toBeLessThanOrEqual(MEMORY_LAST_MAX_CHARS);
  });

  it("reads nothing from a store it cannot parse", () => {
    localStorage.setItem(MEMORY_LAST_KEY, "{{{");
    expect(lastMemory("a")).toBeNull();
    localStorage.setItem(MEMORY_LAST_KEY, JSON.stringify([{ botId: "a", text: 1 }]));
    expect(lastMemory("a")).toBeNull();
  });
});
