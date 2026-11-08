import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, insertMessage, messageDatabase } from "./message-db.ts";
import { replyActivity } from "./reply-activity.ts";
import type { Message } from "./store.ts";

let seq = 0;
const reply = (at: number, extra: Partial<Message> = {}) =>
  insertMessage("t1", { id: `m${seq++}`, role: "bot", kind: "text", text: "done", at, ...extra });
const local = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

describe("replyActivity", () => {
  const zone = process.env.TZ;
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    process.env.TZ = "Asia/Seoul";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("is empty with no replies", () => {
    const activity = replyActivity(local(11, 4));
    expect(activity).toMatchObject({ start: "2026-05-10", since: null, streak: 0, busiest: null, total: 0 });
    expect(activity.counts).toHaveLength(25 * 7 + 4);
    expect(activity.counts.every((count) => count === 0)).toBe(true);
  });

  it.each(["Asia/Seoul", "America/Los_Angeles", "Asia/Kathmandu"])("splits days at local midnight in %s", (tz) => {
    process.env.TZ = tz;
    reply(local(11, 2, 23, 59));
    reply(local(11, 3, 0, 0));
    reply(local(11, 3, 0, 14));
    reply(local(11, 4, 23, 59));
    const { counts } = replyActivity(local(11, 4, 23, 59));
    expect(counts.slice(-3)).toEqual([1, 2, 1]);
  });

  it("counts only bot text, in the grid for 26 weeks and in the totals since the first reply", () => {
    reply(local(11, 4), { role: "user" });
    reply(local(11, 4), { kind: "activity" });
    reply(new Date(2025, 5, 3, 9).getTime());
    reply(local(5, 9, 23, 59));
    reply(local(11, 5, 0, 0));
    reply(local(5, 10, 0, 0));
    const activity = replyActivity(local(11, 4));
    expect(activity.counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(activity).toMatchObject({ since: "2025-06-03", total: 3 });
  });

  it("runs the streak and the busiest day back past the grid", () => {
    for (let day = 0; day < 200; day++) reply(new Date(2026, 3, 19 + day, 12).getTime());
    for (const hour of [9, 10]) reply(new Date(2026, 0, 2, hour).getTime());
    const activity = replyActivity(local(11, 4));
    expect(activity.streak).toBe(200);
    expect(activity.busiest).toEqual({ day: "2026-01-02", count: 2 });
    expect(activity.since).toBe("2026-01-02");
  });

  it("keeps the streak through a quiet morning and stops at a gap", () => {
    for (const day of [28, 30, 31]) reply(local(10, day));
    for (const day of [1, 2, 3]) reply(local(11, day));
    expect(replyActivity(local(11, 4, 8)).streak).toBe(5);
    reply(local(11, 4, 9));
    expect(replyActivity(local(11, 4, 10)).streak).toBe(6);
    expect(replyActivity(local(11, 5, 10)).streak).toBe(6);
    expect(replyActivity(local(11, 6, 10)).streak).toBe(0);
  });

  it("names the busiest day, the latest on a tie", () => {
    for (const hour of [9, 10, 11]) reply(local(10, 13, hour));
    for (const hour of [9, 10]) reply(local(10, 20, hour));
    for (const hour of [9, 10, 11]) reply(local(10, 27, hour));
    expect(replyActivity(local(11, 4))).toMatchObject({ busiest: { day: "2026-10-27", count: 3 }, total: 8 });
  });

  it("reads 200k rows in under 50 ms", () => {
    const now = local(11, 4);
    const insert = messageDatabase().prepare(
      "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const body = "x".repeat(400);
    messageDatabase().exec("BEGIN");
    for (let index = 0; index < 200_000; index++) {
      const role = index % 3 ? "bot" : "user";
      const kind = index % 4 ? "text" : "activity";
      const at = now - Math.floor((index / 200_000) * 365 * 86_400_000);
      insert.run(`t${index % 50}`, `r${index}`, at, role, kind, body, JSON.stringify({ id: `r${index}`, role, kind, text: body, at }));
    }
    messageDatabase().exec("COMMIT");
    closeMessageDb();
    messageDatabase();
    const started = performance.now();
    const activity = replyActivity(now);
    const ms = performance.now() - started;
    expect(activity.total).toBeGreaterThan(40_000);
    expect(ms).toBeLessThan(50);
  });
});
