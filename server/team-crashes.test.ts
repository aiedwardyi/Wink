import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomKey } from "../shared/credential-request.ts";
import { crashCounter } from "./team-crashes.ts";
import { teamOwnerHash } from "./team-stats.ts";
import { teamTodayRoute } from "./team-today.ts";

const ORIGIN = "https://app.glitchtip.com";
const KEY = "gt-secret-token-123456";
const MIDNIGHT = Date.parse("2026-11-02T00:00:00+09:00");
const saved = { name: "GlitchTip", header: "authorization", prefix: "Bearer ", key: KEY };
const stats = (values: (number | null)[]) => ({ intervals: values.map(() => "2026-11-01T15:00:00+00:00"), groups: [{ series: { "sum(quantity)": values } }] });

function glitchtip(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    return route ? route() : Response.json({ detail: "Not Found" }, { status: 404 });
  });
}

describe("team crashes", () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-team-crashes-"));
    now = MIDNIGHT + 5 * 60 * 60_000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const counter = (fetchImpl: typeof fetch, key: () => CustomKey | null = () => saved) => crashCounter({ origin: ORIGIN, project: "7", key, fetchImpl, now: () => now });

  it("sums today's errors in Korea for the DSN project, finding its org", async () => {
    const fetchImpl = glitchtip({
      "/api/0/organizations/": () => Response.json([{ slug: "other" }, { slug: "wink" }]),
      "/api/0/organizations/wink/stats_v2/": () => Response.json(stats([2, null, 0, 3])),
    });
    const count = counter(fetchImpl);
    expect(await count()).toBe(5);
    const calls = fetchImpl.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), auth: new Headers(init?.headers).get("authorization") }));
    expect(calls.map((call) => call.url.pathname)).toEqual(["/api/0/organizations/", "/api/0/organizations/other/stats_v2/", "/api/0/organizations/wink/stats_v2/"]);
    expect(calls.every((call) => call.auth === `Bearer ${KEY}`)).toBe(true);
    const query = calls[2]!.url.searchParams;
    expect(Object.fromEntries(query)).toEqual({ category: "error", field: "sum(quantity)", interval: "1h", project: "7", start: "2026-11-01T15:00:00.000Z", end: new Date(now).toISOString() });
  });

  it("caches five minutes, keeps the org and starts over at midnight", async () => {
    let today = [1];
    const fetchImpl = glitchtip({
      "/api/0/organizations/": () => Response.json([{ slug: "wink" }]),
      "/api/0/organizations/wink/stats_v2/": () => Response.json(stats(today)),
    });
    const count = counter(fetchImpl);
    expect(await count()).toBe(1);
    today = [4];
    now += 4 * 60_000;
    expect(await count()).toBe(1);
    now += 60_000;
    expect(await count()).toBe(4);
    now = MIDNIGHT + 24 * 60 * 60_000;
    today = [0];
    expect(await count()).toBe(0);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/organizations/"))).toHaveLength(1);
  });

  it("stays a link with no key, no DSN or a GlitchTip error", async () => {
    const fetchImpl = glitchtip({ "/api/0/organizations/": () => Response.json([{ slug: "wink" }]) });
    expect(await counter(fetchImpl, () => null)()).toBeNull();
    expect(await counter(fetchImpl, () => ({ ...saved, key: " " }))()).toBeNull();
    expect(await crashCounter({ origin: ORIGIN, project: null, key: () => saved, fetchImpl })()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await counter(fetchImpl)()).toBeNull();
    expect(await counter(glitchtip({ "/api/0/organizations/": () => Response.json({ detail: "Invalid token" }, { status: 401 }) }))()).toBeNull();
    expect(await counter(vi.fn(async () => { throw new Error(`fetch failed for ${KEY}`); }))()).toBeNull();
  });

  it("gives up after three seconds", async () => {
    const hang = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const started = Date.now();
    expect(await counter(hang)()).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never puts the key in the route's answer", async () => {
    const fetchImpl = glitchtip({
      "/api/0/organizations/": () => Response.json([{ slug: KEY }]),
      [`/api/0/organizations/${KEY}/stats_v2/`]: () => Response.json(stats([KEY.length])),
    });
    const reply = await teamTodayRoute(dir, teamOwnerHash("owner@example.com"), "owner@example.com", ORIGIN, counter(fetchImpl), now);
    expect(reply.body).toMatchObject({ crashes: ORIGIN, crashCount: KEY.length });
    expect(JSON.stringify(reply)).not.toContain(KEY);
  });
});
