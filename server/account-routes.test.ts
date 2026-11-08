import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { AccountLifecycle } from "./account-lifecycle.ts";
import { AccountNameError, createAccountNames, type AccountNames } from "./account-names.ts";
import { createAccountRoutes } from "./account-routes.ts";
import { AccountService } from "./accounts.ts";
import { DATA_DIR, instanceConfigs } from "./config.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { createUsageBoard } from "./usage-board.ts";
import { createUsageHistory } from "./usage-history.ts";

function fixture(withNames = true, store?: AccountNames) {
  const rows = [
    { id: "claude", of: "claude", driverKind: "claudeAgent", generation: 0, existing: true, state: "ready" },
    { id: "acct-one", of: "claude", driverKind: "claudeAgent", generation: 1, existing: false, state: "ready" },
  ];
  const labels = new Map(rows.map((row, index) => [row.id, { id: row.id, engine: "claude" as const, number: index + 1, nickname: null as string | null, name: `Claude ${index + 1}` }]));
  const names = { sync: vi.fn(), get: (id: string) => labels.get(id) ?? null, setNickname: vi.fn((id: string, value: string | null) => {
    const row = labels.get(id);
    if (!row) throw new AccountNameError("unknown-account");
    if (value?.includes("@")) throw new AccountNameError("invalid-character");
    row.nickname = value?.trim() || null;
    row.name = row.nickname ?? `Claude ${row.number}`;
    return { ...row };
  }), nameOf: () => "", selectorOf: () => null, resolve: () => ({ kind: "unknown" as const }) };
  const lifecycle = { accounts: { list: () => rows, isDefault: () => false, drains: {}, snapshot: [], get: () => undefined } } as unknown as AccountLifecycle;
  const registry = { describeCached: async () => [], accountBlocked: () => false } as unknown as ProviderRegistry;
  const onNamesChanged = vi.fn();
  const routes = createAccountRoutes(lifecycle, registry, withNames ? { names: store ?? names, onNamesChanged } : undefined);
  async function request(method: string, path = "/api/accounts", body?: unknown, raw?: string) {
    let status = 0;
    let data: any;
    const req = Readable.from(raw !== undefined ? [raw] : body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
    req.headers = { "content-type": "application/json" };
    const res = { writeHead: (code: number) => { status = code; }, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
    const handled = await routes(req, res, method, path);
    return { handled, status, data };
  }
  return { request, names, onNamesChanged, rows };
}

describe("account names routes", () => {
  it.each(["claude", "codex"])("keeps saved %s nicknames through board, usage, sign-in and restart refreshes", async (engine) => {
    const dir = join(DATA_DIR, `name-refresh-${engine}`);
    const driverKind = engine === "claude" ? "claudeAgent" : "codex";
    const accounts = new AccountService(dir, () => ({ [engine]: { driver: driverKind } }));
    const managed = await accounts.add(engine);
    await accounts.identify(managed.id, "managed-login@example.invalid");
    let names = createAccountNames(dir);
    names.sync(accounts.list());
    const board = createUsageBoard({
      accounts: { list: () => accounts.list().map((row) => ({ ...row, status: { state: "available", authenticated: true,
        account: `${row.existing ? "base" : "managed"}-login@example.invalid` } })), defaultFor: (base) => accounts.defaultFor(base), drains: {} },
      names: { get: (id) => names.get(id) }, rateLimits: new Map(), bots: () => [],
      history: createUsageHistory(dir, { schedule: () => {} }), runs: async () => ({ known: true, runs: [] }),
    });
    const wire = () => createAccountRoutes({ accounts } as unknown as AccountLifecycle,
      { describeCached: async () => [], accountBlocked: () => false } as unknown as ProviderRegistry,
      { names, onNamesChanged: () => { board.touch(); } });
    let routes = wire();
    const request = async (method: string, id?: string, nickname?: string | null) => {
      const req = Readable.from(id ? [JSON.stringify({ nickname })] : []) as IncomingMessage;
      req.headers = { "content-type": "application/json" };
      let data: any;
      const res = { writeHead: (status: number) => { expect(status).toBe(200); }, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
      expect(await routes(req, res, method, id ? `/api/accounts/${id}/name` : "/api/accounts")).toBe(true);
      return data;
    };
    const first = await board.read();
    for (const [id, nickname] of [[engine, "base-login"], [managed.id, "managed-login"]]) {
      expect(await request("POST", id, nickname)).toMatchObject({ id, nickname, name: nickname });
    }
    const check = async (cursor?: string) => {
      const value = await board.read(cursor);
      for (const [id, nickname] of [[engine, "base-login"], [managed.id, "managed-login"]]) {
        expect(value.engines[0].accounts.find((row) => row.id === id)).toMatchObject({ nickname, name: nickname });
        expect((await request("GET")).accounts.find((row: { id: string }) => row.id === id)).toMatchObject({ nickname, name: nickname });
      }
      expect(JSON.stringify(value)).not.toContain("@example.invalid");
      return value.cursor;
    };
    const cursor = await check(first.cursor);
    board.recordReport(engine, { observedAt: new Date().toISOString(), windows: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await check(cursor);
    await accounts.identify(managed.id, "refreshed-login@example.invalid", true);
    names.sync(accounts.list());
    board.touch();
    await check();
    names = createAccountNames(dir);
    names.sync(accounts.list());
    routes = wire();
    await check();
    await request("POST", engine, "작업실");
    expect((await board.read()).engines[0].accounts[0]).toMatchObject({ nickname: "작업실", name: "작업실" });
    await request("POST", engine, null);
    expect((await board.read()).engines[0].accounts[0]).toMatchObject({ nickname: null, name: `${engine === "claude" ? "Claude" : "Codex"} 1` });
  });

  it("lists number, nickname and name on every account row", async () => {
    const f = fixture();
    const result = await f.request("GET");
    expect(result.status).toBe(200);
    expect(result.data.accounts).toEqual(f.rows.map((row, index) => ({ ...row, number: index + 1, nickname: null, name: `Claude ${index + 1}` })));
    expect(f.names.sync).toHaveBeenCalledWith(f.rows);
  });

  it("sets and clears a nickname", async () => {
    const f = fixture();
    expect(await f.request("POST", "/api/accounts/acct-one/name", { nickname: "Studio" })).toMatchObject({ status: 200,
      data: { id: "acct-one", number: 2, nickname: "Studio", name: "Studio" } });
    expect(await f.request("POST", "/api/accounts/acct-one/name", { nickname: null })).toMatchObject({ status: 200,
      data: { id: "acct-one", number: 2, nickname: null, name: "Claude 2" } });
    expect(f.onNamesChanged).toHaveBeenCalledTimes(2);
  });

  it("refuses an invalid nickname with a code and never echoes it", async () => {
    const f = fixture();
    const local = ["synthetic", "identity"].join("-");
    const domain = ["canary", "invalid"].join(".");
    const nickname = [local, domain].join("@");
    const result = await f.request("POST", "/api/accounts/acct-one/name", { nickname });
    expect(result).toMatchObject({ status: 400, data: { error: expect.any(String), code: "invalid-character" } });
    expect([nickname, local, domain].some((part) => JSON.stringify(result).includes(part))).toBe(false);
    expect(f.onNamesChanged).not.toHaveBeenCalled();
  });

  it("keeps the existing routes and rows without names", async () => {
    const f = fixture(false);
    expect((await f.request("GET")).data.accounts).toEqual(f.rows);
    expect(await f.request("POST", "/api/accounts/acct-one/name", { nickname: "Studio" })).toMatchObject({ handled: false, status: 0 });
  });

  it("returns unknown-account and rejects malformed name bodies", async () => {
    const f = fixture();
    expect(await f.request("POST", "/api/accounts/missing/name", { nickname: null })).toMatchObject({ status: 404, data: { code: "unknown-account" } });
    for (const body of [{}, { nickname: 1 }, { nickname: "Studio", extra: true }, null]) {
      expect(await f.request("POST", "/api/accounts/acct-one/name", body)).toMatchObject({ status: 400, data: { code: "invalid-character" } });
    }
    expect(f.onNamesChanged).not.toHaveBeenCalled();
  });

  it("persists real nicknames and exposes the same names through GET", async () => {
    const dir = join(DATA_DIR, "account-names-routes");
    mkdirSync(dir, { recursive: true });
    const names = createAccountNames(dir);
    const f = fixture(true, names);
    expect(await f.request("POST", "/api/accounts/acct-one/name", { nickname: " 작업실 " })).toMatchObject({ status: 200, data: { name: "작업실", nickname: "작업실" } });
    expect(createAccountNames(dir).get("acct-one")?.name).toBe("작업실");
    expect((await f.request("GET")).data.accounts[1]).toMatchObject({ number: 2, nickname: "작업실", name: "작업실" });
    const before = readFileSync(join(dir, "account-names.json"), "utf8");
    for (const [nickname, code] of [["x".repeat(25), "too-long"], ["Claude 2", "reserved"], ["작업실", "taken"]]) {
      expect(await f.request("POST", "/api/accounts/claude/name", { nickname })).toMatchObject({ status: 400, data: { code } });
    }
    expect(await f.request("POST", "/api/accounts/claude/name", undefined, "{")).toMatchObject({ status: 400, data: { code: "invalid-character" } });
    expect(readFileSync(join(dir, "account-names.json"), "utf8")).toBe(before);
    expect(f.onNamesChanged).toHaveBeenCalledOnce();
    expect(await f.request("POST", "/api/accounts/acct-one/name", { nickname: " " })).toMatchObject({ status: 200, data: { nickname: null, name: "Claude 2" } });
  });
});

describe("lone base sign-in", () => {
  it("signs a lone signed-out base account in again through the account routes and clears its mark", async () => {
    const dir = join(DATA_DIR, "lone-base-sign-in");
    mkdirSync(dir, { recursive: true });
    const bases = { claude: { driver: "claudeAgent" } };
    const accounts = new AccountService(dir, () => bases);
    const fake = makeFakeDriver({ kind: "claudeAgent" }).driver;
    const registry = new ProviderRegistry([{ ...fake, create: async (input) => ({ ...await fake.create(input),
      snapshot: async () => ({ state: "available" as const, authenticated: true }) }) }]);
    await registry.load(instanceConfigs({ instances: bases }, []));
    const startSignIn = vi.spyOn(registry, "startSignIn").mockResolvedValue({ url: "https://claude.com/cai/oauth/authorize?fixture" });
    const cancelSignIn = vi.spyOn(registry, "cancelSignIn").mockResolvedValue(true);
    vi.spyOn(registry.logins, "wait").mockResolvedValue();
    const changed = vi.fn();
    const lifecycle = new AccountLifecycle(accounts, registry, { reload: async () => {}, referenced: async () => false, invalidate: vi.fn(), changed });
    const routes = createAccountRoutes(lifecycle, registry);
    const request = async (method: string, path: string) => {
      let status = 0;
      let data: any;
      const req = Readable.from([JSON.stringify({})]) as IncomingMessage;
      req.headers = { "content-type": "application/json" };
      const res = { writeHead: (code: number) => { status = code; }, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
      const handled = await routes(req, res, method, path);
      return { handled, status, data };
    };
    try {
      registry.blockAccount("claude", true);
      expect(await request("POST", "/api/instances/claude/sign-out")).toMatchObject({ handled: false });
      expect(await request("POST", "/api/instances/claude/sign-in")).toEqual({ handled: true, status: 200, data: { url: "https://claude.com/cai/oauth/authorize?fixture" } });
      await lifecycle.settled("claude");
      expect(registry.accountBlocked("claude")).toBe(false);
      expect(changed).toHaveBeenCalled();
      expect(changed.mock.calls.every((call) => call[0] === undefined)).toBe(true);
      expect(await request("POST", "/api/instances/claude/sign-in")).toMatchObject({ handled: false });
      registry.blockAccount("claude", true);
      expect(await request("DELETE", "/api/instances/claude/sign-in")).toEqual({ handled: true, status: 200, data: {} });
      expect(cancelSignIn).toHaveBeenCalledExactlyOnceWith("claude");
      startSignIn.mockResolvedValue(null);
      expect(await request("POST", "/api/instances/claude/sign-in")).toEqual({ handled: true, status: 404, data: { error: "Unknown engine sign-in" } });
      expect(registry.accountBlocked("claude")).toBe(true);
    } finally {
      lifecycle.dispose();
      await registry.disposeAll();
    }
  });
});
