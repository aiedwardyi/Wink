import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportStore } from "../relay/src/reports.ts";
import { SnagStore } from "../relay/src/snags.ts";
import { claimTeamReports } from "./team-report-owner.ts";
import { claimTeamSnags } from "./team-snags-owner.ts";
import { teamOwnerHash } from "./team-stats.ts";
import { teamTodayRoute } from "./team-today.ts";
it("the upgraded home PC shows reports already filed today by the still-running work PC", async () => {
  const root = mkdtempSync(join(tmpdir(), "two-owner-pcs-"));
  const relay = join(root, "relay"), work = join(root, "work-v225"), home = join(root, "home-v226");
  for (const dir of [relay, work, home, join(relay, "team-reports")])
    mkdirSync(dir, { recursive: true });
  const now = Date.now(), email = "owner@example.invalid", owner = teamOwnerHash(email), label = "a".repeat(16);
  const report = { id: "b".repeat(32), owner, at: now, bot: { id: "bot", name: "Bot" }, threadId: "thread", branchId: "branch", selectedMessageId: "selected", requestMessageId: "request", summary: "Synthetic bug report", diagnosis: "Synthetic diagnosis", originals: [], images: [], diagnostics: "", incident: { engine: "unknown", model: "unknown", version: "unknown" }, current: { engine: "codex", model: "test", version: "1.0.225" }, missing: [] };
  writeFileSync(join(relay, "team-reports", report.id + ".json"), JSON.stringify({ report, label, subHash: "c".repeat(64), received: now, filed: false, lease: 0 }));
  const reports = new ReportStore(relay, email);
  const snags = await SnagStore.open(relay, 10, () => now);
  snags.add(label, { id: "d".repeat(32), at: now, event: "stalled", build: "1.0.225", os: "win32", teacher: "Bot", worker: "worker", pane8: "pane", label: "pane", minutes: 20, notes: [], detail: "Synthetic snag", tail: "" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/team/today")
      return Response.json({ start: Math.floor((now + 9 * 3600000) / 86400000) * 86400000 - 9 * 3600000, snags: snags.countToday(), bugs: await reports.countToday(now) });
    if (url.pathname === "/v1/team/reports/claim")
      return Response.json({ reports: await reports.claim(now) });
    if (url.pathname === "/v1/team/reports/ack") {
      await reports.ack(JSON.parse(String(init?.body)).ids, now);
      return Response.json({ filed: true });
    }
    if (url.pathname === "/v1/team/snags/claim")
      return Response.json({ snags: snags.claim().map(({ label, snag }) => ({ ...snag, pc: { label, name: "Teammate", person: "Peer" } })) });
    if (url.pathname === "/v1/team/snags/ack")
      return Response.json({ acked: snags.ack(JSON.parse(String(init?.body)).ids) });
    throw new Error("unexpected synthetic relay request " + url.pathname);
  };
  const tokens = { idToken: () => null, freshIdToken: async () => "synthetic-token-never-sent" };
  const reportOpts = (dir: string) => ({ dir: join(dir, "team-report-inbox"), base: () => "example.invalid", baked: null, owner, email: () => email, tokens, post: () => true, postedIds: () => new Set<string>(), fetchImpl });
  const snagOpts = (dir: string) => ({ file: join(dir, "team-snags.jsonl"), enrolledBase: () => "example.invalid", baked: null, ownerHash: owner, email: () => email, tokens, post: () => true, fetchImpl, now: () => now });
  try {
    expect(await claimTeamReports(reportOpts(work))).toBe(1);
    expect(await claimTeamSnags(snagOpts(work))).toBe(1);
    expect(await claimTeamReports(reportOpts(home))).toBe(0);
    expect(await claimTeamSnags(snagOpts(home))).toBe(0);
    const workCounts = await teamTodayRoute(work, owner, email, null, undefined, now);
    expect(workCounts.body).toMatchObject({ snags: 1, bugs: 1 });
    const homeCounts = await teamTodayRoute(home, owner, email, null, undefined, now, { base: "example.invalid", baked: null, tokens, fetchImpl });
    expect(homeCounts.body).toMatchObject({ snags: 1, bugs: 1 });
    await reports.close();
    await snags.close();
    const reopenedReports = new ReportStore(relay, email);
    const reopenedSnags = await SnagStore.open(relay, 10, () => now);
    try {
      expect(await reopenedReports.countToday(now)).toBe(1);
      expect(reopenedSnags.countToday()).toBe(1);
      expect(await reopenedReports.claim(now)).toEqual([]);
      expect(reopenedSnags.claim()).toEqual([]);
    }
    finally {
      await reopenedReports.close();
      await reopenedSnags.close();
    }
  }
  finally {
    await reports.close();
    await snags.close();
    rmSync(root, { recursive: true, force: true });
  }
});
