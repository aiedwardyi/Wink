import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { liveBlock, observeLive } from "./side-live-state.ts";

const T0 = Date.parse("2026-11-09T05:00:00.000Z");
let n = 0;
const event = (threadId: string, atMs: number, body: Record<string, unknown>) =>
  ({ eventId: `e${n++}`, provider: "claude", threadId, createdAt: new Date(T0 + atMs).toISOString(), ...body }) as RuntimeEvent;
const started = (threadId: string, atMs: number, itemId: string, title: string, summary?: string) =>
  event(threadId, atMs, { type: "item.started", itemType: "tool", itemId, title, ...(summary ? { summary } : {}) });
const completed = (threadId: string, atMs: number, itemId: string, writes?: string[]) =>
  event(threadId, atMs, { type: "item.completed", itemType: "tool", itemId, ok: true, ...(writes ? { writes } : {}) });

describe("liveBlock", () => {
  it("lists open tools as still running and finished writes as changed", () => {
    const t = "live-1";
    observeLive(event(t, 0, { type: "turn.started" }));
    observeLive(started(t, 1_000, "w1", "Edit", "notes.md +1 -1"));
    observeLive(completed(t, 1_500, "w1", ["D:/work/notes.md"]));
    observeLive(started(t, 3_000, "a1", "mcp__agents__ask_bot", "pokkey"));
    observeLive(started(t, 14_000, "e1", "Edit", "config.json +1 -1"));
    const block = liveBlock(t, T0 + 15_000);
    expect(block).toContain(`as of ${new Date(T0 + 15_000).toTimeString().slice(0, 8)}`);
    expect(block).toContain("still running, no result yet");
    expect(block).toContain("ask_bot pokkey (started 12 s ago)");
    expect(block).toContain("Edit config.json (started 1 s ago)");
    expect(block).toContain("changed this turn: read before quoting");
    expect(block).toMatch(/answer is dropped: notes.md]$/);
    expect(block).not.toContain("Edit notes.md");
    expect(block).not.toContain("config.json,");
    expect(block).not.toMatch(/read before quoting:.*config\.json/);
  });

  it("is empty for an empty turn, an unknown thread and after the turn ends", () => {
    observeLive(event("live-2", 0, { type: "turn.started" }));
    expect(liveBlock("live-2", T0)).toBe("");
    expect(liveBlock("live-none", T0)).toBe("");
    observeLive(started("live-2", 100, "x1", "Bash", "npm test"));
    expect(liveBlock("live-2", T0 + 200)).not.toBe("");
    observeLive(event("live-2", 300, { type: "turn.completed", ok: true }));
    expect(liveBlock("live-2", T0 + 400)).toBe("");
  });

  it("starts each turn clean", () => {
    observeLive(event("live-3", 0, { type: "turn.started" }));
    observeLive(started("live-3", 10, "w1", "Write", "a.md +3"));
    observeLive(completed("live-3", 20, "w1", ["D:/work/a.md"]));
    observeLive(event("live-3", 30, { type: "turn.started" }));
    expect(liveBlock("live-3", T0 + 40)).toBe("");
  });

  it("stays within 600 characters", () => {
    observeLive(event("live-4", 0, { type: "turn.started" }));
    for (let i = 0; i < 40; i++) {
      observeLive(started("live-4", i, `w${i}`, "Write", `src/file-${i}.ts +10`));
      observeLive(completed("live-4", i, `w${i}`, [`D:/some/long/workspace/path/src/file-${i}.ts`]));
    }
    for (let i = 0; i < 3; i++) observeLive(started("live-4", 50, `o${i}`, "mcp__agents__ask_bot", `bot-with-a-long-name-${i}`));
    const block = liveBlock("live-4", T0 + 60);
    expect(block.length).toBeLessThanOrEqual(600);
    expect(block).toMatch(/\(list incomplete\)\]$/);
    expect(block).toContain("file-39.ts");
  });
});
