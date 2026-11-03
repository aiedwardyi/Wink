import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const { calls, children, wait, retire, kill, probe } = vi.hoisted(() => ({
  calls: [] as { method: string }[], children: [] as EventEmitter[],
  probe: { failure: "", account: { type: "chatgpt", email: "stub@example.com" } as { type: string; email?: string } | null },
  wait: vi.fn(async () => {}), retire: vi.fn(), kill: vi.fn(),
}));
vi.mock("../procs.ts", async (original) => ({
  ...await original<typeof import("../procs.ts")>(),
  execCli: (_cli: string, args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => callback(null, args[0] === "--version" ? "codex-cli test" : "Logged in using ChatGPT"),
  killCliTree: kill,
  spawnCli: () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr: new PassThrough(), exitCode: null, signalCode: null,
      stdin: new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(String(chunk));
        calls.push(request);
        if (request.method === "account/read" && probe.failure) {
          queueMicrotask(() => {
            if (probe.failure === "close") child.emit("close", 1);
            else if (probe.failure === "rpc") stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: "probe failed" } })}\n`);
          });
          done();
          return;
        }
        const result = request.method === "model/list" ? { data: [{ id: "gpt-6.1-sol", isDefault: true }], nextCursor: null }
          : request.method === "account/read" ? { account: probe.account }
            : request.method === "account/rateLimits/read" ? { rateLimits: {} }
              : request.method === "thread/start" ? { thread: { id: "native" } }
                : request.method === "turn/start" ? { turn: { id: "turn" } } : {};
        if (request.id !== undefined) queueMicrotask(() => stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
        if (request.method === "turn/start") queueMicrotask(() => stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } })}\n`));
        done();
      } }),
    });
    children.push(child);
    return child;
  },
}));
vi.mock("./codex-catalog.ts", async (original) => ({
  ...await original<typeof import("./codex-catalog.ts")>(),
  awaitDyingAppServers: wait, retireAppServer: retire,
}));

import { readUsageRpc } from "../usage-refresh.ts";
import { CodexDriver } from "./codex.ts";
import { codexAccount } from "./codex-account.ts";

afterEach(() => {
  for (const child of children.splice(0)) child.emit("close", 0);
  calls.splice(0);
  vi.clearAllMocks();
  probe.failure = "";
  probe.account = { type: "chatgpt", email: "stub@example.com" };
});

it("keeps base catalog, snapshots and turns free of account RPCs and extra spawns", async () => {
  const home = join(homedir(), ".codex");
  mkdirSync(home, { recursive: true });
  const token = `header.${Buffer.from(JSON.stringify({ email: "base@example.com" })).toString("base64url")}.signature`;
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { id_token: token } }));
  const instance = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", enabled: true, config: { cli: "stub-codex", fullAuto: false }, environment: { CODEX_HOME: home } });
  try {
    expect(calls.some((call) => call.method === "account/read")).toBe(false);
    expect(children).toHaveLength(1);
    expect(await instance.snapshot({ refresh: true })).toMatchObject({ authenticated: true, account: "base@example.com" });
    expect(children).toHaveLength(1);
    wait.mockClear();
    await instance.adapter.sendTurn({ threadId: "base", text: "hello" });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(2);
    expect(calls.some((call) => call.method === "account/read")).toBe(false);
  } finally { await instance.dispose(); }
});

it.each([false, true])("coordinates usage-refresh retirement only for accounts (%s)", async (managed) => {
  const account = managed ? { id: "acct_test", of: "codex", home: join(homedir(), "managed"), generation: 1 } : undefined;
  await readUsageRpc("stub-codex", {}, account);
  expect(wait).toHaveBeenCalledTimes(managed ? 1 : 0);
  expect(retire).toHaveBeenCalledTimes(managed ? 1 : 0);
  expect(kill).toHaveBeenCalledTimes(managed ? 0 : 1);
  expect(calls.some((call) => call.method === "account/read")).toBe(managed);
});

it("keeps account admission in the managed catalog and snapshot", async () => {
  const account = { id: "acct_test", of: "codex", home: join(homedir(), "managed"), generation: 1 };
  const instance = await CodexDriver.create({ instanceId: account.id, displayName: "Codex", enabled: true, config: { cli: "stub-codex", fullAuto: false }, environment: {}, account });
  try {
    expect(calls.some((call) => call.method === "account/read")).toBe(true);
    expect(await instance.snapshot({ refresh: true })).toMatchObject({ authenticated: true, account: "stub@example.com" });
  } finally { await instance.dispose(); }
});

it("does not spawn an account reader for a refreshed base snapshot", async () => {
  const instance = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", enabled: true, config: { cli: "stub-codex", fullAuto: false }, environment: {} });
  try {
    const count = children.length;
    expect(await instance.snapshot({ refresh: true })).toMatchObject({ authenticated: true });
    expect(children).toHaveLength(count);
  } finally { await instance.dispose(); }
});

it.each(["rpc", "close", "timeout"])("preserves unknown authentication after a managed %s failure", async (failure) => {
  const account = { id: "acct_test", of: "codex", home: join(homedir(), "managed"), generation: 1 };
  const instance = await CodexDriver.create({ instanceId: account.id, displayName: "Codex", enabled: true, config: { cli: "stub-codex", fullAuto: false }, environment: {}, account });
  try {
    probe.failure = failure;
    expect(await instance.snapshot({ refresh: true })).toMatchObject({ state: "available", authenticated: undefined });
  } finally { await instance.dispose(); }
});

it.each([null, { type: "apikey" }])("still rejects a known non-ChatGPT account (%j)", async (value) => {
  const account = { id: "acct_test", of: "codex", home: join(homedir(), "managed"), generation: 1 };
  const instance = await CodexDriver.create({ instanceId: account.id, displayName: "Codex", enabled: true, config: { cli: "stub-codex", fullAuto: false }, environment: {}, account });
  try {
    probe.account = value;
    expect(await instance.snapshot({ refresh: true })).toMatchObject({ authenticated: false });
  } finally { await instance.dispose(); }
});

it.each([
  [{ tokens: { id_token: `x.${Buffer.from('{"email":"base@example.com"}').toString("base64url")}.x` } }, "base@example.com"],
  [{ tokens: { id_token: `x.${Buffer.from('{"name":"Personal"}').toString("base64url")}.x` } }, "Personal"],
  [{ auth_mode: "apikey", tokens: { id_token: "x.e30.x" } }, undefined],
  [{ tokens: { id_token: "malformed" } }, undefined],
])("preserves the base auth-file label (%j)", (auth, label) => {
  const home = join(homedir(), ".codex");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
  expect(codexAccount({ CODEX_HOME: home })).toBe(label);
});
