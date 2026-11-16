import { describe, expect, it } from "vitest";
import { checkTestSleeps, testSleepHits } from "./check-test-sleeps.mjs";

const file = "server/fixture.test.ts";
const check = (source) => testSleepHits(file, source);
const sleep = 'it("waits", async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });';

describe("test sleep gate", () => {
  it.each([
    sleep,
    'it("stays quiet", async () => { await new Promise(r => setTimeout(r, 200)); expect(spy).not.toHaveBeenCalled(); });',
    'it("waits", async () => { await new Promise<void>((done) => { setTimeout(() => done(), 100); }); });',
    'it("waits", async () => { await new Promise((resolve) => void setTimeout(resolve, 100).unref()); });',
    'import { setTimeout as delay } from "node:timers/promises"; it("waits", async () => { await delay(100); });',
    'const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); it("waits", async () => { await pause(300); });',
    'function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); } it("waits", async () => { await wait(20); });',
    'const settle = () => new Promise((resolve) => setTimeout(resolve, 30)); it("waits", async () => { await settle(); });',
    'for (const name of names) it(name, async () => { await new Promise((r) => setTimeout(r, 50)); });',
  ])("rejects a sleep: %s", (source) => {
    expect(check(source)).toHaveLength(1);
  });

  it.each([
    "async function until(check) { while (!check()) await new Promise((r) => setTimeout(r, 10)); }",
    "for (let i = 0; i < 100 && !posts.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));",
    'import { setTimeout as delay } from "node:timers/promises"; async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await delay(5); } }',
    'it("yields", async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });',
    'it("races", async () => { await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve("hung"), 4_000))]); });',
    'it("drives time", async () => { vi.useFakeTimers(); setTimeout(fire, 100); await vi.advanceTimersByTimeAsync(100); });',
    'it("waits on the event", async () => { await vi.waitFor(() => expect(spy).toHaveBeenCalled()); });',
  ])("accepts a poll, a yield, a late fake reply and driven time: %s", (source) => {
    expect(check(source)).toEqual([]);
  });

  it("fails the gate for a new file and for an extra sleep in a listed file, naming the fix", () => {
    const [error, ...more] = checkTestSleeps([file], () => sleep, {});
    expect(more).toEqual([]);
    expect(error).toContain(`${file}:1: sleep in a test`);
    expect(error).toContain("vi.waitFor");
    expect(error).toContain("vi.useFakeTimers()");
    expect(checkTestSleeps([file], () => sleep, { [file]: 1 })).toEqual([]);
    expect(checkTestSleeps([file], () => `${sleep}\n${sleep}`, { [file]: 1 })).toHaveLength(1);
  });

  it("fails the gate when a listed file has fewer sleeps than its entry permits", () => {
    expect(checkTestSleeps([file], () => "", { [file]: 2 })).toEqual([`${file}: test-sleeps.json allows 2 sleeps but the file has 0; run node scripts/check-test-sleeps.mjs --lower`]);
  });

  it("accepts the repository with only its listed sleeps", () => {
    expect(checkTestSleeps()).toEqual([]);
  });
});
