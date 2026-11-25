import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { sweepDroppedAsks } from "./task-dropped.ts";
import { removeTestData } from "./testing/test-home.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("task drop log", () => {
  beforeEach(() => {
    removeTestData(DATA_DIR);
  });

  it("keeps 90 days of lines at boot and removes a log left empty", () => {
    const dir = join(DATA_DIR, "task-state-dropped");
    const now = 200 * DAY;
    const line = (at: number) => `${JSON.stringify({ at, botId: "bot-1", threadId: "thread-1", ask: { id: "A1", ask: "Ship the notes", status: "done", at: 0, changedAt: at } })}\n`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "thread-1.jsonl"), line(now - 91 * DAY) + line(now - 89 * DAY));
    writeFileSync(join(dir, "thread-2.jsonl"), line(now - 120 * DAY));

    sweepDroppedAsks(now);

    expect(readFileSync(join(dir, "thread-1.jsonl"), "utf8")).toBe(line(now - 89 * DAY));
    expect(existsSync(join(dir, "thread-2.jsonl"))).toBe(false);
    const boot = readFileSync(new URL("./index.ts", import.meta.url), "utf8").split(/\r?\n/).filter((code) => code.includes("sweepDroppedAsks("));
    expect(boot).toEqual(['startupTiming.afterPaint("droppedAsks", async () => sweepDroppedAsks());']);
  });
});
