import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { teamOwnerHash } from "./team-route.ts";
import { kstDayStart, teamTodayRoute } from "./team-today.ts";

const OWNER = teamOwnerHash("owner@example.com");
const MIDNIGHT = Date.parse("2026-11-02T00:00:00+09:00");

describe("team today", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-team-today-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function snags(...rows: [string, number][]) {
    writeFileSync(join(dir, "team-snags.jsonl"), `${rows.map(([id, at]) => JSON.stringify({ id, at, event: "stuck-worker" })).join("\n")}\nnot json\n`);
  }

  function report(id: string, at: number, filed = at) {
    const inbox = join(dir, "team-report-inbox", id);
    mkdirSync(inbox, { recursive: true });
    const file = join(inbox, "report.json");
    writeFileSync(file, JSON.stringify({ report: { id, at }, received: at }));
    utimesSync(file, filed / 1000, filed / 1000);
  }

  it("starts the day at midnight in Korea", () => {
    expect(kstDayStart(MIDNIGHT)).toBe(MIDNIGHT);
    expect(kstDayStart(MIDNIGHT - 1)).toBe(MIDNIGHT - 24 * 60 * 60_000);
    expect(kstDayStart(Date.parse("2026-11-02T14:59:59Z"))).toBe(MIDNIGHT);
    expect(kstDayStart(Date.parse("2026-11-02T15:00:00Z"))).toBe(MIDNIGHT + 24 * 60 * 60_000);
  });

  it("counts today's snags and reports and resets at midnight", async () => {
    snags(["a", MIDNIGHT - 1], ["b", MIDNIGHT], ["c", MIDNIGHT + 60_000], ["c", MIDNIGHT + 60_000]);
    report("r1", MIDNIGHT - 60_000, MIDNIGHT + 60_000);
    report("r2", MIDNIGHT + 5_000);
    report("r3", MIDNIGHT + 9_000);
    const before = await teamTodayRoute(dir, OWNER, "owner@example.com", null, undefined, MIDNIGHT - 1);
    expect(before).toEqual({ status: 200, body: { snags: 1, bugs: 1, crashes: null, crashCount: null } });
    const today = await teamTodayRoute(dir, OWNER, " Owner@Example.com ", "https://crash.example", async () => 7, MIDNIGHT + 10_000);
    expect(today).toEqual({ status: 200, body: { snags: 2, bugs: 2, crashes: "https://crash.example", crashCount: 7 } });
    const tomorrow = await teamTodayRoute(dir, OWNER, "owner@example.com", null, undefined, MIDNIGHT + 24 * 60 * 60_000);
    expect(tomorrow.body).toEqual({ snags: 0, bugs: 0, crashes: null, crashCount: null });
  });

  it("reads zero when nothing was filed", async () => {
    expect((await teamTodayRoute(dir, OWNER, "owner@example.com", null, undefined, MIDNIGHT)).body).toEqual({ snags: 0, bugs: 0, crashes: null, crashCount: null });
  });

  it("answers only the owner", async () => {
    snags(["a", MIDNIGHT]);
    const denied = { status: 403, body: { owner: false } };
    const count = vi.fn(async () => 7);
    expect(await teamTodayRoute(dir, OWNER, "someone@example.com", "https://crash.example", count, MIDNIGHT)).toEqual(denied);
    expect(await teamTodayRoute(dir, OWNER, null, null, count, MIDNIGHT)).toEqual(denied);
    expect(await teamTodayRoute(dir, null, "owner@example.com", null, count, MIDNIGHT)).toEqual(denied);
    expect(count).not.toHaveBeenCalled();
  });
});
