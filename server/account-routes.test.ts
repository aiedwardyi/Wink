import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { AccountLifecycle } from "./account-lifecycle.ts";
import { AccountNameError, createAccountNames, type AccountNames } from "./account-names.ts";
import { createAccountRoutes } from "./account-routes.ts";
import { DATA_DIR } from "./config.ts";
import type { ProviderRegistry } from "./harness/registry.ts";

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
