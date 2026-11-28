import { describe, expect, it } from "vitest";

import { importMemoryPins } from "./import-memory-pin.ts";

describe("import_memory pinned to its provider session", () => {
  it("keeps the tool for every resume of the session that started with it", () => {
    const pins = importMemoryPins();
    expect(pins.forTurn("t1", "gemini", undefined, true)).toBe(true);
    expect(pins.forTurn("t1", "gemini", "conv-1", true)).toBe(true);
    expect(pins.forTurn("t1", "gemini", "conv-1", false)).toBe(true);
    expect(pins.forTurn("t1", "gemini", "conv-1", false)).toBe(true);
    expect(pins.open("t1")).toBe(false);
  });

  it("a new, recycled or compacted session, another engine or a restart goes by the per-turn rule", () => {
    const pins = importMemoryPins();
    pins.forTurn("t1", "codex", "thread-1", true);
    expect(pins.forTurn("t1", "codex", undefined, false)).toBe(false);
    pins.forTurn("t1", "codex", "thread-1", true);
    expect(pins.forTurn("t1", "codex", "thread-2", false)).toBe(false);
    pins.forTurn("t1", "codex", "thread-1", true);
    expect(pins.forTurn("t1", "claude", "thread-1", false)).toBe(false);
    pins.forTurn("t1", "codex", "thread-1", true);
    expect(importMemoryPins().forTurn("t1", "codex", "thread-1", false)).toBe(false);
  });

  it("never pins a chat the rule closed, so a long chat gets nothing", () => {
    const pins = importMemoryPins();
    expect(pins.forTurn("t1", "grok", undefined, false)).toBe(false);
    expect(pins.forTurn("t1", "grok", "s1", false)).toBe(false);
    expect(pins.open("t1")).toBe(false);
  });

  it("opens saving only on a turn the rule opened", () => {
    const pins = importMemoryPins();
    pins.forTurn("t1", "claude", undefined, true);
    expect(pins.open("t1")).toBe(true);
    // Import Memory saved or declined mid-session
    pins.forTurn("t1", "claude", "s1", false);
    expect(pins.open("t1")).toBe(false);
    expect(pins.open("t2")).toBe(false);
  });

  it("holds a bounded number of chats", () => {
    const pins = importMemoryPins(2);
    for (const thread of ["t1", "t2", "t3"]) pins.forTurn(thread, "claude", "s", true);
    expect(pins.forTurn("t1", "claude", "s", false)).toBe(false);
    expect(pins.forTurn("t3", "claude", "s", false)).toBe(true);
  });
});
