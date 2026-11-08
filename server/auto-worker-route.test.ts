import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTO_ENGINES, type AutoEngine } from "../shared/auto-routing.ts";
import { createAutoRoutingService } from "./auto-routing-service.ts";
import { DATA_DIR } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { callTool } from "./drivers/terminal-proxy.ts";
import { createSpawnUsage } from "./spawn-usage.ts";
import { Store } from "./store.ts";
import { terminalReadGrant } from "./terminal-grant.ts";
import { turnRegistry } from "./turn-registry.ts";
import { createWorkerLaunch } from "./worker-launch.ts";
import { workerAutoResponse, workerLaunchResponse } from "./worker-panes.ts";
import { createWorkerTurns } from "./worker-turn.ts";

const { createTerminalBridge } = await import(new URL("../electron/terminal-bridge.mjs", import.meta.url).href);
const { createTerminalHost } = await import(new URL("../electron/terminal-host.mjs", import.meta.url).href);
const { reportWorkerAuto, resolveWorkerLaunch } = await import(new URL("../electron/terminal-worker.mjs", import.meta.url).href);
const auto = await import("./auto-worker-launch.ts").catch(() => null);
const task = { prompt: "Read card.md and do it.", kind: "edit", risk: "low", scope: "bounded" };
const DRIVERS: Record<AutoEngine, string> = { claudeAgent: "claude", codex: "codex", grokAgent: "grok", antigravityAgent: "antigravity", museAgent: "muse" };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

type Child = { writes: string[]; failWrite?: boolean; data?(text: string): void; exit?(event: { exitCode: number }): void };
async function fixture(enabled: AutoEngine[] = ["claudeAgent"], options: { dir?: string; failWrite?: boolean; hostRuns?: () => Promise<{ known: true; runs: { routeId: string; nativeId: string; paneId: string }[] } | { known: false }> } = {}) {
  expect(auto, "structured Auto launch exists").not.toBeNull();
  const dir = options.dir ?? join(DATA_DIR, randomUUID());
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));
  const bot = store.createBot();
  const service = createAutoRoutingService(dir, store);
  service.setEnabled(bot.id, true);
  const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Use Sol high please" });
  const turnId = randomUUID();
  turnRegistry.start(turnId, { botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0, userKeys: [message.id] });
  const turns = createWorkerTurns();
  turns.capture(bot.id, bot.threadId, { instanceId: "claude", driverKind: "claudeAgent" });
  const bases = Object.fromEntries(AUTO_ENGINES.map((engine) => [DRIVERS[engine], { driver: engine, enabled: enabled.includes(engine) }])) as InstanceConfigMap;
  const down = new Set<string>();
  const observedAt = { value: new Date().toISOString() };
  const usage = { value: 20 };
  const available = (id: string) => !down.has(id);
  const spawnUsage = createSpawnUsage({ rateLimits: new Map(), refresh: async () => ({}), save() {}, environment: () => ({}) });
  const legacy = createWorkerLaunch({ enabled: () => false, resolveWorkerTurn: turns.resolveWorkerTurn, bases: () => bases, available, usage: spawnUsage, accounts: () => [] });
  const refresh = vi.fn(async (_id: string) => {});
  const candidates = () => auto!.autoCandidates({ bases: () => bases, accounts: () => [], currentGeneration: (id) => (down.has(id) ? undefined : 0), signedIn: available, draining: () => false,
    efforts: () => ["low", "medium", "high", "xhigh", "max"], main: () => undefined,
    usage: () => ({ observedAt: observedAt.value, windows: [{ id: "five_hour", usedPercent: usage.value, resetsAt: null }] }) });
  const workers = auto!.createAutoWorkers({ dataDir: dir, service, workerLaunch: legacy, resolveWorkerTurn: turns.resolveWorkerTurn, candidates, available: (id) => available(id), refresh,
    hostRuns: options.hostRuns ?? (async () => ({ known: true as const, runs: [] })) });
  const children: Child[] = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  let access: { url: string; token: string };
  const server = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>;
    const body = JSON.parse(String(init!.body));
    const result = String(url).endsWith("/worker-launch")
      ? await workerLaunchResponse(access, headers["x-orbit-terminal-host"], body, workers.launch)
      : await workerAutoResponse(access, headers["x-orbit-terminal-host"], body, workers.signal);
    return Response.json(result.body, { status: result.status });
  };
  const host = createTerminalHost({ authorize() {}, owner: () => owner, resolveCwd: async () => tmpdir(), platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 64 * 1024 ** 3,
    workerAccountsEnabled: false,
    workerLaunch: (input: unknown) => resolveWorkerLaunch({ url: "http://server", token: "server" }, access, input, server),
    workerAuto: (input: unknown) => reportWorkerAuto({ url: "http://server", token: "server" }, access, input, server),
    loadPty: () => ({ spawn: () => {
      const child = { writes: [] as string[], failWrite: options.failWrite === true, onData(cb: Child["data"]) { this.data = cb; }, onExit(cb: Child["exit"]) { this.exit = cb; },
        write(text: string) { if (this.failWrite) throw new Error("write failed"); this.writes.push(text); }, resize() {}, kill() {} } as Child & Record<string, unknown>;
      children.push(child);
      return child;
    } }) });
  const bridge = createTerminalBridge({ host });
  access = await bridge.start();
  cleanups.push(async () => { await bridge.close(); await host.dispose(); });
  const config = { host: access.url, token: terminalReadGrant(access.token, bot.id), botId: bot.id, auto: true };
  const spawn = (args: Record<string, unknown>) => callTool("terminal_spawn", fetch, config, { label: "BUILDER", ...args });
  return { bot, dir, host, service, workers, children, spawn, config, down, observedAt, usage, refresh, bases, turnId };
}
const text = (result: { content: { text: string }[] }) => result.content[0].text;
const panes = (f: Awaited<ReturnType<typeof fixture>>) => f.children.filter((child) => child.writes.some((line) => line.includes("--model") || line.includes(" -m ")));
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("structured Auto spawn on the real launch path", () => {
  it("launches through proxy, bridge, host and worker route with zero managed accounts", async () => {
    const f = await fixture();
    const result = await f.spawn({ task });
    expect(text(result)).toContain("Opened pane");
    const [row] = f.workers.runtime.rows();
    expect(row).toMatchObject({ stage: "running", route: { engine: "claudeAgent", account: "claude", generation: 0 } });
    expect(row.paneId).toBeTruthy();
    const line = panes(f)[0].writes.join("");
    for (const part of ["'claude'", "'--model'", `'${row.route.model}'`, "'--effort'", `'${row.route.effort}'`, "'--session-id'", `'${row.nativeId}'`, `'${task.prompt}'`]) expect(line).toContain(part);
    const snapshot = await f.host.readBot(f.bot.id, { sessionId: row.paneId });
    expect(snapshot.label).toContain("BUILDER");
    expect(snapshot.label).toContain(row.route.effort);
  });

  it("leaves no worker state before the first Auto spawn", async () => {
    const f = await fixture();
    f.workers.paneReport("pane", "DONE BUILDER branch=x sha=y dirty=0");
    f.workers.invalidate("claude");
    await f.workers.reconcile();
    expect(existsSync(join(f.dir, "auto-routing-workers.json"))).toBe(false);
  });

  it("refuses a task with a command", async () => {
    const f = await fixture();
    expect(text(await f.spawn({ task, command: "claude" }))).toMatch(/task or command/i);
    expect(f.children).toEqual([]);
  });

  it("does not forward a task when Auto is off", async () => {
    const calls: unknown[] = [];
    const fake = async (_url: string | URL | Request, init?: RequestInit) => { calls.push(JSON.parse(String(init!.body))); return Response.json({ sessionId: "pane", generation: 1 }); };
    await callTool("terminal_spawn", fake as typeof fetch, { host: "http://host", token: "t", botId: "bot" }, { label: "B", task });
    expect(calls).toEqual([{ label: "B" }]);
  });

  it("opens one pane for a repeated request in one turn", async () => {
    const f = await fixture();
    const first = await f.spawn({ task });
    const second = await f.spawn({ task });
    expect(panes(f)).toHaveLength(1);
    expect(f.workers.runtime.rows()).toHaveLength(1);
    expect(text(first)).toContain(f.workers.runtime.rows()[0].paneId);
    expect(text(second)).toContain(f.workers.runtime.rows()[0].paneId);
  });

  it("holds without a pane and a repeat never overrides the hold", async () => {
    const f = await fixture();
    f.usage.value = 90;
    for (let n = 0; n < 2; n++) expect(text(await f.spawn({ task }))).toMatch(/held/i);
    expect(f.children).toEqual([]);
    expect(f.workers.runtime.rows()).toEqual([]);
  });

  it("re-resolves once when the account drops during preparation", async () => {
    const f = await fixture(["claudeAgent", "codex"]);
    f.observedAt.value = new Date(Date.now() - 10 * 60_000).toISOString();
    f.refresh.mockImplementation(async () => { f.down.add("claude"); });
    await f.spawn({ task });
    expect(f.workers.runtime.rows()[0]).toMatchObject({ stage: "running", attempts: 2, route: { engine: "codex" } });
    expect(panes(f)).toHaveLength(1);
  });

  it("never relaunches after uncertain acceptance", async () => {
    const f = await fixture(["claudeAgent"], { failWrite: true });
    expect((await f.spawn({ task })).isError).toBe(true);
    await settled();
    expect(["unknown", "ended"]).toContain(f.workers.runtime.rows()[0].stage);
    expect(text(await f.spawn({ task }))).toMatch(/held/i);
    expect(f.children).toHaveLength(1);
  });

  it("releases a run exactly once across report and close", async () => {
    const f = await fixture();
    await f.spawn({ task });
    const [row] = f.workers.runtime.rows();
    expect(f.workers.runtime.candidates()[0].active).toBe(1);
    f.workers.paneReport(row.paneId!, "DONE BUILDER branch=x sha=y dirty=0");
    expect(f.workers.runtime.candidates()[0].active).toBe(0);
    await callTool("terminal_close", fetch, f.config, { sessionId: row.paneId });
    await settled();
    const outcomes = readFileSync(join(f.dir, "auto-routing-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.kind === "report" || event.kind === "closed");
    expect(outcomes).toEqual([expect.objectContaining({ kind: "report", status: "done" })]);
  });

  it("releases a closed pane and keeps a stalled one counted", async () => {
    const f = await fixture();
    await f.spawn({ task });
    const [row] = f.workers.runtime.rows();
    await f.workers.signal({ routeId: row.routeId, event: "stalled" });
    expect(f.workers.runtime.rows()[0].stage).toBe("running");
    await callTool("terminal_close", fetch, f.config, { sessionId: row.paneId });
    await vi.waitFor(() => expect(f.workers.runtime.rows()[0].stage).toBe("ended"));
  });

  it("marks LIMIT exhausted on a young cache and holds the next spawn", async () => {
    const f = await fixture();
    await f.spawn({ task });
    const [row] = f.workers.runtime.rows();
    await f.workers.signal({ routeId: row.routeId, event: "limit" });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(text(await f.spawn({ task: { ...task, prompt: "Another job." } }))).toMatch(/held/i);
  });

  it("restores counts on restart and retains unknown-host coverage", async () => {
    const f = await fixture();
    await f.spawn({ task });
    const [row] = f.workers.runtime.rows();
    await expect(f.workers.signal({ routeId: row.routeId, event: "recovered", paneId: "new-pane", nativeId: randomUUID() })).rejects.toThrow(/identity/);
    await f.workers.signal({ routeId: row.routeId, event: "recovered", paneId: "new-pane", nativeId: row.nativeId });
    expect(f.workers.runtime.rows()[0].paneId).toBe("new-pane");
    const unknown = await fixture(["claudeAgent"], { dir: f.dir, hostRuns: async () => ({ known: false }) });
    await unknown.workers.reconcile();
    expect(unknown.workers.runtime.rows()[0].stage).toBe("running");
    expect(unknown.workers.runtime.candidates()[0]).toMatchObject({ active: 1, loadKnown: false });
    const dead = await fixture(["claudeAgent"], { dir: f.dir });
    await dead.workers.reconcile();
    expect(dead.workers.runtime.rows().find((entry) => entry.routeId === row.routeId)?.stage).toBe("ended");
  });

  it("invalidates pending routes only and leaves running work", async () => {
    const f = await fixture();
    await f.spawn({ task });
    f.workers.invalidate("claude");
    expect(f.workers.runtime.rows()[0].stage).toBe("running");
  });

  it("honors a verified pin and holds an unverified one", async () => {
    const f = await fixture(["claudeAgent", "codex"]);
    await f.spawn({ task, pin: { model: "gpt-6.1-sol", effort: "high", userQuote: "Sol high" } });
    expect(f.workers.runtime.rows()[0].route).toMatchObject({ engine: "codex", model: "gpt-6.1-sol", effort: "high" });
    expect(text(await f.spawn({ task: { ...task, prompt: "Other." }, pin: { model: "claude-opus-5-5", userQuote: "Opus" } }))).toMatch(/held/i);
    expect(f.workers.runtime.rows()).toHaveLength(1);
  });

  it("gives every engine a task arm with only signed-in base accounts", async () => {
    const f = await fixture([...AUTO_ENGINES]);
    expect(f.workers.runtime.candidates().map((row) => row.engine).sort()).toEqual([...AUTO_ENGINES].sort());
    expect(f.workers.runtime.candidates().every((row) => row.models.length > 0 && row.generation === 0)).toBe(true);
  });

  it("is wired into the real server route and turn-scoped tool env", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/worker-launch[\s\S]{0,260}autoWorkers\.launch/);
    expect(source).toMatch(/\/api\/internal\/worker-auto[\s\S]{0,260}autoWorkers\.signal/);
    expect(source).toMatch(/OMB_AUTO_ROUTING/);
  });
});
