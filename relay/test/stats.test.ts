import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { STATS_MAX_BYTES, STATS_MAX_INFLATED } from "../../shared/usage-stats.ts";
import { configSchema } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { STATS_PER_INSTALL_PER_DAY, StatsStore } from "../src/stats.ts";
import { startRelay, type Harness } from "./fixtures.ts";

const READ_KEY = randomBytes(32).toString("base64url");
const STATS = { keepDays: 90, maxDayBytes: 200 * 1024 * 1024, readKeySha256: createHash("sha256").update(READ_KEY).digest("hex") };
const NOON = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;
const TODAY = "2026-11-12";

const screen = { e: "screen", h: Math.floor(NOON / 3_600_000), c: "desktop", name: "chat", n: 1 };
const batch = (patch: Record<string, unknown> = {}) => ({
  v: 1, id: "a".repeat(32), batch: randomBytes(16).toString("hex"), app: "1.0.256", channel: "stable", internal: false,
  os: "win32", osBuild: "10.0.26100", arch: "x64", lang: "en", osLang: "ko", dropped: 0, events: [screen], ...patch,
});

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function call(h: Harness, method: string, path: string, opts: { body?: string | Buffer; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: h.port, servername: `relay.${h.base}`, ca: h.ca.certPem, method, path, agent: false, headers: { host: `relay.${h.base}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const JSON_TYPE = { "content-type": "application/json" };
const post = (h: Harness, body: unknown, headers: Record<string, string> = JSON_TYPE) =>
  call(h, "POST", "/v1/stats", { body: Buffer.isBuffer(body) ? body : JSON.stringify(body), headers });
const getDay = (h: Harness, date: string, key?: string) =>
  call(h, "GET", `/v1/stats/day/${date}`, key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } });
const reply = (res: { body: Buffer }) => JSON.parse(res.body.toString("utf8"));
const lines = async (dir: string, date = TODAY) =>
  (await readFile(join(dir, "stats", `${date}.ndjson`), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function store(now: () => number, config: Partial<typeof STATS> = {}, logs: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "wink-stats-"));
  dirs.push(dir);
  const open = () => StatsStore.open(dir, { ...STATS, ...config }, now, createLogger((line) => logs.push(line), now));
  return { dir, logs, open, stats: await open() };
}

describe("POST /v1/stats", () => {
  it("answers 404 for both routes without stats in config", async () => {
    h = await startRelay();
    expect((await post(h, batch())).status).toBe(404);
    expect((await getDay(h, TODAY, READ_KEY)).status).toBe(404);
  });

  it("stores a batch with no address, label or time, and logs nothing", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    const before = h.logs.length;
    const sent = batch();
    const res = await post(h, sent);
    expect(res.status).toBe(200);
    expect(reply(res)).toEqual({ ok: true, rejected: 0 });
    const stored = await lines(h.dataDir);
    expect(stored).toEqual([sent]);
    expect(Object.keys(stored[0]).slice(0, 2)).toEqual(["batch", "id"]);
    expect(h.logs.slice(before)).toEqual([]);
    expect(await readFile(join(h.dataDir, "stats", `${TODAY}.ndjson`), "utf8")).not.toMatch(/127\.0\.0\.1|::1|peer|label/);
  });

  it("takes a gzipped body", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    const sent = batch();
    const res = await post(h, gzipSync(JSON.stringify(sent)), { ...JSON_TYPE, "content-encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(await lines(h.dataDir)).toEqual([sent]);
    expect((await post(h, gzipSync(JSON.stringify(batch())), { ...JSON_TYPE, "content-encoding": "GZip" })).status).toBe(200);
  });

  it("stores a repeated batch once", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    const sent = batch();
    expect((await post(h, sent)).status).toBe(200);
    expect((await post(h, sent)).status).toBe(200);
    expect(await lines(h.dataDir)).toHaveLength(1);
  });

  it("drops events it does not know and keeps the rest", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    const sent = batch({ events: [screen, { ...screen, name: "Tax return 2026" }, { e: "future", h: screen.h }, { ...screen, title: "minsu" }] });
    const res = await post(h, sent);
    expect(reply(res)).toEqual({ ok: true, rejected: 3 });
    expect(await lines(h.dataDir)).toEqual([{ ...sent, rejected: 3, events: [screen] }]);
    expect(await readFile(join(h.dataDir, "stats", `${TODAY}.ndjson`), "utf8")).not.toMatch(/Tax return|minsu|future/);
  });

  it.each([
    ["an unknown envelope key", batch({ hostname: "DESKTOP-MINSU" })],
    ["free text in the envelope", batch({ app: "C:\\Users\\minsu\\Wink" })],
    ["an account next to the install", batch({ account: "minsu@example.com" })],
    ["only events it does not know", batch({ events: [{ ...screen, name: "secret" }] })],
    ["no events", batch({ events: [] })],
    ["over 2,000 events", batch({ events: Array(2001).fill(screen) })],
    ["a body that is not an object", "hello"],
  ])("rejects %s and stores nothing", async (_what, body) => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    const res = await post(h, body);
    expect(res.status).toBe(400);
    expect(await readdir(join(h.dataDir, "stats"))).toEqual([]);
  });

  it("rejects the wrong method, type, size and a gzip bomb", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    expect((await call(h, "GET", "/v1/stats")).status).toBe(405);
    expect((await post(h, batch(), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(h, Buffer.from("{not json"))).status).toBe(400);
    expect((await post(h, Buffer.from("not gzip"), { ...JSON_TYPE, "content-encoding": "gzip" })).status).toBe(400);
    expect((await post(h, Buffer.alloc(STATS_MAX_BYTES + 1, 0x20))).status).toBe(413);
    const bomb = gzipSync(Buffer.alloc(STATS_MAX_INFLATED + 1, 0x20));
    expect(bomb.length).toBeLessThan(STATS_MAX_BYTES);
    expect((await post(h, bomb, { ...JSON_TYPE, "content-encoding": "gzip" })).status).toBe(413);
    expect(await readdir(join(h.dataDir, "stats"))).toEqual([]);
  });

  it("limits batches per address", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON, limits: { statsPerIpPerHour: 2 } });
    expect((await post(h, batch())).status).toBe(200);
    expect((await post(h, batch())).status).toBe(200);
    expect((await post(h, batch())).status).toBe(429);
    expect(await lines(h.dataDir)).toHaveLength(2);
  });
});

describe("GET /v1/stats/day", () => {
  it("serves a day to the read key only", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    const sent = [batch(), batch({ id: "b".repeat(32) })];
    for (const one of sent) await post(h, one);
    const before = h.logs.length;
    for (const key of [undefined, "", "x".repeat(43), READ_KEY.slice(0, -1), `${READ_KEY}x`, STATS.readKeySha256]) {
      const res = await getDay(h, TODAY, key);
      expect(res.status, String(key)).toBe(401);
      expect(res.body.toString("utf8")).not.toContain(sent[0]!.batch);
    }
    expect(h.logs.slice(before).join("\n")).not.toContain(READ_KEY.slice(0, -1));
    const res = await getDay(h, TODAY, READ_KEY);
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(res.body).toString("utf8")).toBe(await readFile(join(h.dataDir, "stats", `${TODAY}.ndjson`), "utf8"));
    expect((await call(h, "POST", `/v1/stats/day/${TODAY}`, { headers: { authorization: `Bearer ${READ_KEY}` } })).status).toBe(405);
  });

  it("answers 404 for a day with no file and for anything that is not a date", async () => {
    h = await startRelay({ stats: STATS, now: () => NOON });
    await post(h, batch());
    for (const date of ["2026-11-11", "2026-11-12.ndjson", "..%2Fteam-sessions", "20261112", "2026-11-12/x"]) {
      expect((await getDay(h, date, READ_KEY)).status, date).toBe(404);
    }
  });
});

describe("StatsStore", () => {
  it("stops one install at its daily cap, also after a restart", async () => {
    const s = await store(() => NOON);
    for (let i = 0; i < STATS_PER_INSTALL_PER_DAY; i++) expect((await s.stats.submit(batch())).status).toBe(200);
    expect((await s.stats.submit(batch())).status).toBe(429);
    expect((await s.stats.submit(batch({ id: "b".repeat(32) }))).status).toBe(200);
    await s.stats.close();
    const again = await s.open();
    expect((await again.submit(batch())).status).toBe(429);
    const seen = (await lines(s.dir))[0];
    expect((await again.submit(seen)).status).toBe(200);
    expect(await lines(s.dir)).toHaveLength(STATS_PER_INSTALL_PER_DAY + 1);
    await again.close();
  });

  it("ends a line a dead write left open, and takes that batch again", async () => {
    const s = await store(() => NOON);
    const [kept, cut, next] = [batch(), batch(), batch()];
    await s.stats.submit(kept);
    await s.stats.submit(cut);
    await s.stats.close();
    const file = join(s.dir, "stats", `${TODAY}.ndjson`);
    const [first = "", second = ""] = (await readFile(file, "utf8")).split("\n");
    await writeFile(file, `${first}\n${second.slice(0, -20)}`);
    const again = await s.open();
    expect((await again.submit(next)).status).toBe(200);
    expect((await again.submit(cut)).status).toBe(200);
    expect((await again.submit(kept)).status).toBe(200);
    await again.close();
    const stored = (await readFile(file, "utf8")).split("\n");
    expect(stored).toEqual([first, second.slice(0, -20), stored[2], second, ""]);
    expect(JSON.parse(stored[2] ?? "")).toEqual(next);
  });

  it("answers 507 once the day is full", async () => {
    const size = Buffer.byteLength(JSON.stringify(batch())) + 1;
    const s = await store(() => NOON, { maxDayBytes: size * 2 });
    expect((await s.stats.submit(batch())).status).toBe(200);
    expect((await s.stats.submit(batch())).status).toBe(200);
    expect((await s.stats.submit(batch())).status).toBe(507);
    expect(await lines(s.dir)).toHaveLength(2);
    await s.stats.close();
  });

  it("gzips a finished day, still serves it, and drops a retry that crosses midnight", async () => {
    let now = NOON;
    const s = await store(() => now);
    const sent = batch();
    await s.stats.submit(sent);
    const plain = await readFile(join(s.dir, "stats", `${TODAY}.ndjson`), "utf8");
    now += DAY;
    await s.stats.tick();
    expect(await readdir(join(s.dir, "stats"))).toEqual([`${TODAY}.ndjson.gz`]);
    const chunks: Buffer[] = [];
    for await (const chunk of (await s.stats.read(TODAY))!) chunks.push(chunk);
    expect(gunzipSync(Buffer.concat(chunks)).toString("utf8")).toBe(plain);
    expect((await s.stats.submit(sent)).status).toBe(200);
    expect(await readdir(join(s.dir, "stats"))).toEqual([`${TODAY}.ndjson.gz`]);
    expect(await s.stats.read("2026-11-01")).toBeNull();
    await s.stats.close();
  });

  it("deletes days past keepDays and leaves other files alone", async () => {
    let now = NOON;
    const s = await store(() => now, { keepDays: 2 });
    await s.stats.submit(batch());
    await writeFile(join(s.dir, "stats", "notes.txt"), "keep");
    now += 2 * DAY;
    await s.stats.tick();
    expect((await readdir(join(s.dir, "stats"))).sort()).toEqual([`${TODAY}.ndjson.gz`, "notes.txt"]);
    now += DAY;
    await s.stats.tick();
    expect(await readdir(join(s.dir, "stats"))).toEqual(["notes.txt"]);
    await s.stats.close();
  });

  it("logs one line an hour with a count and a size, and nothing when idle", async () => {
    const s = await store(() => NOON);
    await s.stats.tick();
    expect(s.logs).toEqual([]);
    const sent = [batch(), batch({ events: [screen, { ...screen, name: "minsu" }] })];
    for (const one of sent) await s.stats.submit(one);
    await s.stats.submit(sent[0]);
    await s.stats.tick();
    await s.stats.tick();
    const bytes = (await readFile(join(s.dir, "stats", `${TODAY}.ndjson`))).length;
    expect(s.logs.map((line) => JSON.parse(line))).toEqual([{ t: new Date(NOON).toISOString(), event: "stats-hour", count: 2, bytesIn: bytes }]);
    await s.stats.close();
  });
});

describe("stats config", () => {
  const base = { base: "wink.example.com", acme: { directoryUrl: "https://acme.example/dir", termsOfServiceAgreed: true } };

  it("is off unless set, and fills the defaults", () => {
    expect(configSchema.parse(base).stats).toBeUndefined();
    expect(configSchema.parse({ ...base, stats: { readKeySha256: STATS.readKeySha256 } }).stats).toEqual(STATS);
  });

  it.each([{}, { readKeySha256: READ_KEY }, { readKeySha256: STATS.readKeySha256, keepDays: 0 }, { readKeySha256: STATS.readKeySha256, readKey: READ_KEY }])(
    "rejects %j",
    (stats) => {
      expect(configSchema.safeParse({ ...base, stats }).success).toBe(false);
    },
  );
});
