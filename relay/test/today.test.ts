import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApiServer, type ApiOptions } from "../src/http.ts";
import { ReportStore } from "../src/reports.ts";
import { SnagStore } from "../src/snags.ts";
import { TodayCount } from "../src/today.ts";
import type { Accounts } from "../src/accounts.ts";
import type { TeamStats } from "../src/team.ts";
import { silentLogger } from "../src/log.ts";

const MIDNIGHT = Date.parse("2026-11-03T00:00:00+09:00");
const DAY = 86_400_000;
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "relay-today-")); dirs.push(dir); return dir; };

it("persists unique KST event IDs, excludes other days and rolls over", () => {
  const file = join(tempDir(), "today");
  const count = new TodayCount(file);
  count.record([{ id: A, at: MIDNIGHT }, { id: B, at: MIDNIGHT - 1 }, { id: C, at: MIDNIGHT + DAY }], MIDNIGHT);
  count.record([{ id: A, at: MIDNIGHT }], MIDNIGHT);
  expect(new TodayCount(file).count(MIDNIGHT + DAY - 1)).toBe(1);
  expect(count.count(MIDNIGHT + DAY)).toBe(0);
  count.record([{ id: C, at: MIDNIGHT + DAY }], MIDNIGHT + DAY);
  expect(new TodayCount(file).count(MIDNIGHT + DAY)).toBe(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ start: MIDNIGHT + DAY, ids: [C] });
});

it("keeps snag counts across ack retries, restart and same-ID redelivery", async () => {
  const dir = tempDir();
  let now = MIDNIGHT;
  let store = await SnagStore.open(dir, 10, () => now);
  const snag = { id: A, at: MIDNIGHT, event: "stalled" as const, build: "1.0.225", os: "win32", teacher: "Bot", worker: "worker", pane8: "pane", label: "pane", minutes: 20, notes: [], detail: "private", tail: "private" };
  try {
    store.add("a".repeat(16), snag);
    expect(store.countToday()).toBe(0);
    expect(store.ack([A])).toBe(1);
    expect(store.ack([A])).toBe(0);
    await store.close();
    store = await SnagStore.open(dir, 10, () => now);
    expect(store.countToday()).toBe(1);
    expect(store.claim()).toEqual([]);
    store.add("a".repeat(16), snag);
    store.ack([A]);
    expect(store.countToday()).toBe(1);
    now += DAY;
    expect(store.countToday()).toBe(0);
    expect(readFileSync(join(dir, "team-snags-today"), "utf8")).not.toContain("private");
  } finally { await store.close(); }
});

it("refuses to discard reports when their daily ledger cannot be written", async () => {
  const dir = tempDir();
  mkdirSync(join(dir, "team-reports"));
  const report = { id: A, owner: "a".repeat(64), at: MIDNIGHT, bot: { id: "bot", name: "Bot" }, threadId: "thread", branchId: "branch", selectedMessageId: "selected", requestMessageId: "request", summary: "Synthetic", diagnosis: "", originals: [], images: [], diagnostics: "", incident: { engine: "unknown", model: "unknown", version: "unknown" }, current: { engine: "test", model: "test", version: "1.0.225" }, missing: [] };
  const file = join(dir, "team-reports", `${A}.json`);
  writeFileSync(file, JSON.stringify({ report, label: "a".repeat(16), subHash: "subject", received: MIDNIGHT, filed: false, lease: 0 }));
  mkdirSync(join(dir, "team-reports-today"));
  const store = new ReportStore(dir, "owner@example.test");
  try {
    await expect(store.ack([A], MIDNIGHT)).rejects.toThrow();
    expect(JSON.parse(readFileSync(file, "utf8")).filed).toBe(false);
  } finally { await store.close(); }
});

it("serves only authenticated owners and preserves the existing team response", async () => {
  const owner: Accounts["owner"] = vi.fn<Accounts["owner"]>(async (token) => token === "owner.token.sig" ? { ok: true, subHash: "owner" } : { ok: false, status: 403, error: "not-owner" });
  const snags: SnagStore["countToday"] = vi.fn(() => 2);
  const reports: ReportStore["countToday"] = vi.fn(async () => 3);
  const stats: TeamStats = { now: MIDNIGHT, days: [], pcs: [], people: [] };
  // SAFETY: only the owner, count and stats methods are reachable on these requests.
  const server = createApiServer({
    base: "example.test", relayHost: "relay.example.test",
    accounts: { owner }, signinOrigin: "https://signin.test", teamOwnerEmail: "owner@example.test",
    team: { stats: (_tz: number) => stats }, snags: { countToday: snags }, reports: { countToday: reports },
    limits: { pcsPerIpPerMin: 100 }, log: silentLogger, now: () => MIDNIGHT,
  } as ApiOptions);
  const call = (token?: string, method = "GET", url = "/v1/team/today") => new Promise<{ status: number; body: unknown }>((resolve) => {
    const req = new IncomingMessage(new Socket());
    req.method = method; req.url = url;
    req.headers = { host: "relay.example.test" };
    if (token) req.headers.authorization = `Bearer ${token}`;
    let status = 0;
    // SAFETY: this handler only calls writeHead and end on successful JSON replies.
    const res = { writeHead(code: number) { status = code; }, end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as ServerResponse;
    server.emit("request", req, res);
  });
  try {
    expect((await call()).status).toBe(401);
    expect((await call("peer.token.sig")).status).toBe(403);
    expect((await call("owner.token.sig", "POST")).status).toBe(405);
    expect(snags).not.toHaveBeenCalled();
    expect(reports).not.toHaveBeenCalled();
    expect(await call("owner.token.sig")).toEqual({ status: 200, body: { start: MIDNIGHT, snags: 2, bugs: 3 } });
    expect(await call("owner.token.sig", "GET", "/v1/team")).toEqual({ status: 200, body: stats });
  } finally { server.close(); }
});
