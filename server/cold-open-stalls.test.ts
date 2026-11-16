import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { COLD_OPEN_FILE, receiveColdOpen } from "./cold-open-diag.ts";
import { loopStallsDuring, onLoopStall, watchLoopStalls, type LoopStall } from "./loop-stalls.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const post = (body: object) => Readable.from([Buffer.from(JSON.stringify(body))]);
const lines = (dir: string) => readFileSync(join(dir, COLD_OPEN_FILE), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const block = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const open = { label: "open", mount: 400, sseOpen: 4000, chatPaint: 4100, displayMode: "standalone", visibility: "visible", userAgent: "Mozilla/5.0 (Linux; Android 10; K) SamsungBrowser/31.0" };

describe("server stalls in the cold-open record", () => {
  it("names the stall an open sat behind, with its start and length, and not one from before the open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wink-cold-open-stalls-"));
    dirs.push(dir);
    watchLoopStalls();
    await settle();
    const blockedAt = Date.now();
    block(2_500);
    await settle();
    await receiveColdOpen(post({ ...open, mount: 1, sseOpen: 1, chatPaint: 1 }), dir);
    await receiveColdOpen(post(open), dir);
    const [after, behind] = lines(dir);
    expect(after.server.stalls).toBeUndefined();
    expect(behind.server.stalls).toHaveLength(1);
    const [stall] = behind.server.stalls;
    expect(stall.ms).toBeGreaterThanOrEqual(1_400);
    expect(stall.ms).toBeLessThanOrEqual(2_600);
    expect(Date.parse(stall.at)).toBeGreaterThanOrEqual(blockedAt - 50);
    expect(Date.parse(stall.at)).toBeLessThanOrEqual(blockedAt + 1_100);
  }, 10_000);

  it("counts a stall whose tick fired after a window that ends inside the tick before it", async () => {
    watchLoopStalls();
    await settle();
    const seen: LoopStall[] = [];
    const stop = onLoopStall((stall) => seen.push(stall));
    block(2_500);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    const [stall] = seen;
    expect(loopStallsDuring(stall.start - 900, stall.start - 1)).toContainEqual(stall);
  }, 10_000);
});
