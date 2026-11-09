import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    observeLive(completed(t, 1_500, "w1", ["work/notes.md"]));
    observeLive(started(t, 3_000, "a1", "mcp__agents__ask_bot", "pokkey"));
    observeLive(started(t, 14_000, "e1", "Edit", "config.json +1 -1"));
    const block = liveBlock(t, T0 + 15_000).text;
    expect(block).toContain(`as of ${new Date(T0 + 15_000).toTimeString().slice(0, 8)}`);
    expect(block).toContain("still running, no result yet");
    expect(block).toContain("ask_bot pokkey (started 12 s ago)");
    expect(block).toContain("Edit config.json (started 1 s ago)");
    expect(block).toContain("changed this turn: look one up (Read, Grep or Glob) in this ask before quoting");
    expect(block).toMatch(/answer is dropped: notes.md]$/);
    expect(block).not.toContain("Edit notes.md");
    expect(block).not.toContain("config.json,");
    expect(block).not.toMatch(/before quoting.*config\.json/);
  });

  it("says a file being written now must not be stated, and stops asking to look it up", () => {
    const t = "live-5";
    observeLive(event(t, 0, { type: "turn.started" }));
    observeLive(started(t, 100, "w1", "Edit", "notes.md +1 -1"));
    observeLive(completed(t, 200, "w1", ["work/notes.md"]));
    observeLive(started(t, 300, "w2", "Edit", "notes.md +1 -1"));
    observeLive(started(t, 400, "w3", "Write", "src/new.js +9"));
    const block = liveBlock(t, T0 + 1_000).text;
    expect(block).toContain("- Being written now, don't state what it says: notes.md, src/new.js");
    expect(block).not.toContain("look one up");
    observeLive(completed(t, 500, "w2", ["work/notes.md"]));
    observeLive(completed(t, 600, "w3", ["work/src/new.js"]));
    expect(liveBlock(t, T0 + 1_000).text).not.toContain("Being written");
  });

  it("is empty for an empty turn, an unknown thread and after the turn ends", () => {
    observeLive(event("live-2", 0, { type: "turn.started" }));
    expect(liveBlock("live-2", T0).text).toBe("");
    expect(liveBlock("live-none", T0).text).toBe("");
    observeLive(started("live-2", 100, "x1", "Bash", "npm test"));
    expect(liveBlock("live-2", T0 + 200).text).not.toBe("");
    observeLive(event("live-2", 300, { type: "turn.completed", ok: true }));
    expect(liveBlock("live-2", T0 + 400).text).toBe("");
  });

  it("starts each turn clean", () => {
    observeLive(event("live-3", 0, { type: "turn.started" }));
    observeLive(started("live-3", 10, "w1", "Write", "a.md +3"));
    observeLive(completed("live-3", 20, "w1", ["work/a.md"]));
    observeLive(event("live-3", 30, { type: "turn.started" }));
    expect(liveBlock("live-3", T0 + 40).text).toBe("");
  });

  it("stays within 600 characters", () => {
    observeLive(event("live-4", 0, { type: "turn.started" }));
    for (let i = 0; i < 40; i++) {
      observeLive(started("live-4", i, `w${i}`, "Write", `src/file-${i}.ts +10`));
      observeLive(completed("live-4", i, `w${i}`, [`some/long/workspace/path/src/file-${i}.ts`]));
    }
    for (let i = 0; i < 3; i++) observeLive(started("live-4", 50, `o${i}`, "mcp__agents__ask_bot", `bot-with-a-long-name-${i}`));
    const block = liveBlock("live-4", T0 + 60).text;
    expect(block.length).toBeLessThanOrEqual(600);
    expect(block).toMatch(/\(list incomplete\)\]$/);
    expect(block).toContain("file-39.ts");
  });
});

describe("liveBlock attachments", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-live-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const wrote = (threadId: string, atMs: number, name: string, body: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    observeLive(started(threadId, atMs, `w${atMs}`, "Write", `${name} +1`));
    observeLive(completed(threadId, atMs, `w${atMs}`, [path]));
    return path;
  };

  it("attaches small changed files as they are now, newest first, within the budget", () => {
    const t = "att-1";
    observeLive(event(t, 0, { type: "turn.started" }));
    const config = wrote(t, 1, "config.json", '{ "port": 4100 }\n');
    wrote(t, 2, "big.md", "x".repeat(2_000));
    wrote(t, 3, "a.md", "a".repeat(1_530));
    const b = wrote(t, 4, "b.md", "b".repeat(1_530));
    writeFileSync(config, '{ "port": 4180 }\n');
    const { text, attached } = liveBlock(t, T0 + 10_000);
    expect(attached).toEqual([b, config]);
    expect(text).toContain('--- config.json ---\n{ "port": 4180 }');
    expect(text).not.toContain("4100");
    expect(text).toMatch(/before quoting or naming it, or your answer is dropped: a\.md, big\.md\n/);
    expect(text).not.toContain("xxx");
    expect(text).not.toContain("aaa");
    expect(text.endsWith("]")).toBe(true);
  });

  it("marks a deleted file and skips a binary one or one still being written", () => {
    const t = "att-2";
    observeLive(event(t, 0, { type: "turn.started" }));
    const gone = wrote(t, 1, "gone.md", "bye");
    rmSync(gone);
    wrote(t, 2, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    wrote(t, 3, "notes.md", "Port: 4100");
    observeLive(started(t, 4, "e1", "Edit", "notes.md +1 -1"));
    const { text, attached } = liveBlock(t, T0 + 5_000);
    expect(attached).toEqual([gone]);
    expect(text).toContain("--- gone.md (deleted) ---");
    expect(text).toContain("Being written now, don't state what it says: notes.md\n");
    expect(text).toMatch(/answer is dropped: logo\.png\n/);
    expect(text).not.toContain("Port: 4100");
  });
});
