import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountLifecycle } from "./account-lifecycle.ts";
import { createAccountRoutes } from "./account-routes.ts";
import { AccountService } from "./accounts.ts";
import { DATA_DIR, instanceConfigs } from "./config.ts";
import type { ProviderSnapshot } from "./contracts.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

const ENGINES = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", antigravity: "antigravityAgent", muse: "museAgent" } as const;
const registries: ProviderRegistry[] = [];
let next = 0;

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
});

async function fixture() {
  const dir = join(DATA_DIR, `sign-in-path-${++next}`);
  mkdirSync(dir, { recursive: true });
  const bases = Object.fromEntries(Object.entries(ENGINES).map(([id, driver]) => [id, { driver }]));
  const accounts = new AccountService(dir, () => bases);
  const statuses = new Map<string, ProviderSnapshot>();
  const registry = new ProviderRegistry(Object.values(ENGINES).map((kind) => {
    const fake = makeFakeDriver({ kind }).driver;
    return { ...fake, defaultConfig: () => ({ cli: "fake" }), install: { login: { args: ["login"], deviceArgs: ["device"] }, logout: ["logout"] },
      create: async (input: Parameters<typeof fake.create>[0]) => ({ ...await fake.create(input),
        snapshot: vi.fn(async (): Promise<ProviderSnapshot> => statuses.get(input.instanceId) ?? { state: "available", authenticated: false }) }),
    };
  }));
  registries.push(registry);
  await registry.load(instanceConfigs({ instances: bases }, accounts.snapshot));
  let finish!: () => void;
  vi.spyOn(registry.logins, "start").mockImplementation(async (id, _cli, args) => {
    if (args.includes("logout")) statuses.set(id, { state: "available", authenticated: false });
    else statuses.set(id, { state: "available", authenticated: true, account: `${id}@example.invalid` });
    return { url: "https://auth.example/sign-in" };
  });
  vi.spyOn(registry.logins, "generation").mockReturnValue(1);
  vi.spyOn(registry.logins, "state").mockReturnValue("complete");
  vi.spyOn(registry.logins, "wait").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const changed = vi.fn();
  const lifecycle = new AccountLifecycle(accounts, registry, { reload: async () => {}, referenced: async () => false, invalidate: vi.fn(), changed });
  const routes = createAccountRoutes(lifecycle, registry);
  const request = async (method: string, path: string) => {
    const req = new IncomingMessage(new Socket());
    req.headers = { "content-type": "application/json" };
    req.push(method === "POST" ? "{}" : null);
    if (method === "POST") req.push(null);
    let status = 0;
    const res = new ServerResponse(req);
    vi.spyOn(res, "writeHead").mockImplementation((code: number) => { status = code; return res; });
    vi.spyOn(res, "end").mockImplementation(() => res);
    return { handled: await routes(req, res, method, path, "pc:"), status };
  };
  return { registry, lifecycle, changed, request, statuses, finish: () => finish() };
}

describe("one sign-in path for every engine", () => {
  it.each(Object.keys(ENGINES))("%s signs in, cancels and signs out through the lifecycle, pushing each end", async (id) => {
    const f = await fixture();
    const signIn = vi.spyOn(f.lifecycle, "signIn");
    const cancel = vi.spyOn(f.lifecycle, "cancel");
    const remove = vi.spyOn(f.lifecycle, "remove");
    expect(await f.request("POST", `/api/instances/${id}/sign-in`)).toEqual({ handled: true, status: 200 });
    expect(signIn).toHaveBeenCalledExactlyOnceWith(id, false, "pc:");
    const pushed = f.changed.mock.calls.length;
    f.finish();
    await f.lifecycle.settled(id);
    expect(f.changed.mock.calls.slice(pushed)).toEqual([[id]]);
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === id)?.snapshot).toMatchObject({ authenticated: true, account: `${id}@example.invalid` });
    expect(await f.request("DELETE", `/api/instances/${id}/sign-in`)).toEqual({ handled: true, status: 200 });
    expect(cancel).toHaveBeenCalledOnce();
    const beforeOut = f.changed.mock.calls.length;
    const out = f.request("POST", `/api/instances/${id}/sign-out`);
    await vi.waitFor(() => expect(f.registry.logins.wait).toHaveBeenCalledTimes(2));
    f.finish();
    expect(await out).toEqual({ handled: true, status: 200 });
    expect(remove).toHaveBeenCalledOnce();
    expect(f.changed.mock.calls.length).toBeGreaterThan(beforeOut);
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === id)?.snapshot.authenticated).toBe(false);
  });

  it("starts and ends sign-ins only from the account lifecycle", () => {
    const server = join(import.meta.dirname);
    const files = readdirSync(server, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !/\.test\.ts$|[\\/]testing[\\/]/.test(file));
    const callers = files.filter((file) => /registry\.(startSignIn|signOut)\(/.test(readFileSync(join(server, file), "utf8")));
    expect(callers.map((file) => relative(".", file).replace(/\\/g, "/"))).toEqual(["account-lifecycle.ts"]);
  });
});
