// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { noteMemoryFrame } from "./memory-clean-events";
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

  it("drops a bot's copy when its memory changes elsewhere or Auto Notes saves", () => {
    const state = { hydrated: true, bots: [{ id: "a", threadId: "t-a" }, { id: "b", threadId: "t-b" }] };
    rememberMemory("a", shown("- one"));
    rememberMemory("b", shown("- two"));
    noteMemoryFrame({ kind: "memory.changed", botId: "a" }, state);
    expect(lastMemory("a")).toBeNull();
    expect(lastMemory("b")).toEqual(shown("- two"));
    noteMemoryFrame({ kind: "message", threadId: "t-b", message: { id: "m1", tool: { name: "memory.save" } } }, state);
    expect(lastMemory("b")).toBeNull();
  });

  it("reads nothing from a store it cannot parse", () => {
    localStorage.setItem(MEMORY_LAST_KEY, "{{{");
    expect(lastMemory("a")).toBeNull();
    localStorage.setItem(MEMORY_LAST_KEY, JSON.stringify([{ botId: "a", text: 1 }]));
    expect(lastMemory("a")).toBeNull();
  });
});
