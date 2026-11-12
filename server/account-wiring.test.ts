import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const source = read("./index.ts");
function section(from: string, to: string, text = source): string {
  const start = text.indexOf(from);
  const end = start < 0 ? -1 : text.indexOf(to, start + from.length);
  expect(start, `missing ${from}`).toBeGreaterThanOrEqual(0);
  expect(end, `unterminated ${from}`).toBeGreaterThan(start);
  return text.slice(start, end);
}
function compile(body: string) {
  const javascript = ts.transpileModule(`async function run(scope) { with (scope) { ${body} } }`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(`${javascript}\nreturn run;`)() as (scope: object) => Promise<any>;
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "wink-wiring-")); dirs.push(dir); return dir; };

const rows = [
  { id: "claude", of: "claude", driverKind: "claudeAgent", generation: 0, existing: true, state: "ready" as const },
  { id: "acct_studio", of: "claude", driverKind: "claudeAgent", generation: 3, existing: false, state: "ready" as const },
];
const report = (usedPercent: number, observedAt = "2026-11-05T10:00:00.000Z") => ({
  windows: [{ id: "five_hour", usedPercent, resetsAt: Date.parse(observedAt) + 300 * 60_000, windowMinutes: 300 }], observedAt,
});

async function wired(main = "claude") {
  const { createAccountNames } = await import("./account-names.ts");
  const { createUsageBoard } = await import("./usage-board.ts");
  const { createUsageHistory } = await import("./usage-history.ts");
  const dir = tempDir();
  const accountNames = createAccountNames(dir);
  const accounts = {
    list: () => rows, defaultFor: () => main, get: (id: string) => rows.find((row) => row.id === id), drains: {},
  };
  accountNames.sync(accounts.list());
  const broadcast = vi.fn();
  const scope = {
    createUsageBoard, createUsageHistory: (path: string) => createUsageHistory(path, { schedule: () => {} }), DATA_DIR: dir,
    accounts, accountNames, registry: { accountBlocked: () => false }, providerSnapshots: new Map(),
    instanceConfigs: () => ({ claude: { driver: "claudeAgent" }, grok: { driver: "grokAgent" } }), cfg: {},
    rateLimitsByInstance: new Map(), liveWorkerRuns: async () => ({ known: false, reason: "no-host" }), terminalBridgeAccess: null,
    store: { bots: [{ id: "atlas", name: "Atlas", modelSelection: { instanceId: "claude" } }] }, broadcast,
    providerReload: { current: (): { instanceId: string; account?: { generation: number } } | null => null },
    codexCreditRows: () => [], codexCreditFor: () => undefined, codexPromoStatus: () => false,
  };
  const board = section("const boardEngines", "\nconst refreshUsage");
  const usageBoard = await compile(`${board}\nreturn usageBoard;`)(scope);
  return { ...scope, usageBoard, broadcast, boardTurnStarted: await compile(`${board}\nreturn boardTurnStarted;`)({ ...scope, createUsageBoard: () => usageBoard }) };
}

it("serves the usage board with a committed revision", async () => {
  const route = section(`    if (method === "GET" && path === "/api/usage/board") {`, `\n\n    if (method === "GET" && path === "/api/instances") {`);
  expect(source.indexOf(route) + route.length + 2).toBe(source.indexOf(`    if (method === "GET" && path === "/api/instances") {`));
  vi.useFakeTimers();
  const s = await wired();
  const serve = compile(`${route}`);
  const json = (_res: unknown, status: number, body: unknown) => ({ status, body });
  const revision = s.usageBoard.touch();
  const answer = await serve({ method: "GET", path: "/api/usage/board", url: new URL("http://127.0.0.1/api/usage/board"), res: {}, json, usageBoard: s.usageBoard });
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ version: 1, revision, full: true });
  expect(answer.body.engines.map((group: { base: string }) => group.base)).toEqual(["claude", "grok"]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(s.broadcast).toHaveBeenCalledWith({ kind: "usage.board", revision });
});

it("records one committed Main change through the lifecycle callback", async () => {
  const hook = section("  onMainChanged: (change) =>", "\n});");
  const s = await wired("acct_studio");
  const accountNotices = { mainChanged: vi.fn() };
  const recordMain = vi.spyOn(s.usageBoard, "recordMain");
  const { onMainChanged } = await compile(`return { ${hook} };`)({ accountNotices, usageBoard: s.usageBoard });
  const change = { base: "claude", engine: "claude", from: { id: "claude", generation: 0 }, to: { id: "acct_studio", generation: 3 }, seq: 7 };
  onMainChanged(change);
  expect(accountNotices.mainChanged).toHaveBeenCalledExactlyOnceWith(change);
  expect(recordMain).toHaveBeenCalledExactlyOnceWith(change);
  const board = await s.usageBoard.read();
  expect(board.engines[0]).toMatchObject({ mainId: "acct_studio" });
  expect(board.engines[0].events).toMatchObject([{ kind: "main", from: "claude", to: "acct_studio" }]);
});

it("does not record a failed or no-op Main change", async () => {
  expect(count(source, "usageBoard.recordMain(")).toBe(1);
  expect(section("  onMainChanged: (change) =>", "\n});")).toContain("usageBoard.recordMain(change)");
  const s = await wired();
  const { onMainChanged } = await compile(`return { ${section("  onMainChanged: (change) =>", "\n});")} };`)({ accountNotices: { mainChanged() {} }, usageBoard: s.usageBoard });
  const change = { base: "claude", engine: "claude", from: { id: "claude", generation: 0 }, to: { id: "acct_studio", generation: 3 }, seq: 2 };
  onMainChanged(change);
  onMainChanged(change);
  onMainChanged({ ...change, seq: 1 });
  expect((await s.usageBoard.read()).engines[0].events).toHaveLength(1);
});

it("tracks room and continuation turns on their captured accounts", async () => {
  const oneToOne = section("      accountNote.commit();\n      markPaneMailRead", "\n      if (currentTurnEpoch(bot.id) !== epoch) return;");
  const room = section("        accountNote.commit();\n        releaseStarting();", "\n      })\n      .catch((err) => {");
  for (const block of [oneToOne, room]) expect(block).toContain("boardTurnStarted(bot.id, threadId, started.turnId);");
  const settle = section("  if (event.turnId) {\n    if (settleMail(", "\n  drainQueuedSends();");
  expect(settle).toContain("usageBoard.turnSettled(event.turnId);");

  const s = await wired();
  s.providerReload.current = () => ({ instanceId: "acct_studio", account: { generation: 3 } });
  s.boardTurnStarted("atlas", "room-1", "turn-room");
  s.boardTurnStarted("atlas", "room-1", "turn-room");
  const busy = async () => (await s.usageBoard.read()).engines[0].accounts.map((account: { id: string; bots: Array<{ busy: boolean }> }) => [account.id, account.bots.filter((bot) => bot.busy).length]);
  expect(await busy()).toEqual([["claude", 0], ["acct_studio", 1]]);

  const settled = compile(`${settle}`);
  const scope = { event: { threadId: "room-1", turnId: "turn-room", ok: true }, settleMail: () => false, store: {}, paneWake: {}, sourceBotId: "atlas", turnRegistry: { settle() {} }, usageBoard: s.usageBoard };
  await settled(scope);
  expect(await busy()).toEqual([["claude", 0], ["acct_studio", 0]]);

  s.providerReload.current = () => ({ instanceId: "claude" });
  s.boardTurnStarted("atlas", "t1", "turn-continued");
  expect(await busy()).toEqual([["claude", 1], ["acct_studio", 0]]);
  await settled({ ...scope, event: { threadId: "t1", turnId: "turn-continued", ok: true } });
  expect(await busy()).toEqual([["claude", 0], ["acct_studio", 0]]);
});

it("keeps account updates running when saving names fails", async () => {
  const s = await wired();
  const accountUpdates = vi.fn();
  const touch = vi.spyOn(s.usageBoard, "touch");
  const changed = section("  changed: (id) =>", "\n  rateLimits:");
  const callback = await compile(`return { ${changed} }.changed;`)({ ...s,
    accountNames: { sync() { throw new Error("fixture save failure"); } }, accountUpdates,
  });
  expect(() => callback("claude")).not.toThrow();
  expect(touch).toHaveBeenCalledOnce();
  expect(accountUpdates).toHaveBeenCalledWith("claude");
});

it("settles a stalled board turn when the watchdog releases it", async () => {
  const s = await wired();
  s.usageBoard.turnStarted({ turnId: "stalled", botId: "atlas", accountId: "claude", generation: 0 });
  const release = section("      providerReload.settled(turn.threadId);", "\n      const group = store.groupByThread(turn.threadId);");
  const turnRegistry = { get: () => ({}), settle: vi.fn() };
  const scope = { ...s, turn: { threadId: "thread", botId: "atlas" }, stalledTurnId: "stalled", turnRegistry,
    providerReload: { settled() {} }, workerTurns: { settled() {} }, settleMail: () => false,
  };
  await compile(release)(scope);
  expect(turnRegistry.settle).toHaveBeenCalledWith("stalled");
  expect((await s.usageBoard.read()).engines[0].accounts[0].bots).toEqual([{ botId: "atlas", bot: "Atlas", busy: false }]);
});

it("holds a starting turn's account until it is accepted", async () => {
  const helpers = section("const startingHolds = new Map", "\n\n");
  const turn = section("async function startClaimedTurn(", "\n  return startedTurn(userMessage);\n}");
  const hold = section("  startingHolds.set(bot.id, accountRuntime.holdStarting(instanceId", "\n", turn);
  expect(turn.indexOf(hold)).toBeGreaterThan(turn.indexOf("  const instanceId = instance.instanceId;"));
  expect(turn.indexOf(hold)).toBeLessThan(turn.indexOf("await summaryBuild.settle("));
  const take = turn.indexOf("    const releaseStarting = takeStartingHold(bot.id);");
  expect(take).toBeGreaterThan(turn.indexOf("  void (async () => {"));
  expect(take).toBeLessThan(turn.indexOf("await ", turn.indexOf("  void (async () => {")));
  expect(section("    } finally {\n      releaseStarting();", "\n  })()", turn)).toBeTruthy();
  expect(section("  } finally {", "\n    turnStartClaims.delete(botId);", section("async function startTurn(", "\n}\n"))).toContain("takeStartingHold(botId)();");
  const roomTurn = section("async function runClaimedGroupMemberTurn(", "\n}\n");
  expect(roomTurn.indexOf("  startingHolds.set(bot.id, accountRuntime.holdStarting(selection.instanceId")).toBeGreaterThan(roomTurn.indexOf("  const instance = selectedInstance &&"));
  expect(roomTurn.indexOf("  const releaseStarting = takeStartingHold(bot.id);\n  releaseTurnStart?.();")).toBeGreaterThan(0);
  expect(roomTurn).toContain("      .catch((err) => {\n        releaseStarting();");
  expect(section("  const releaseTurnStart = () => {", "\n  };")).toContain("takeStartingHold(botId)();");

  const held = new Set<string>();
  const accountRuntime = { holdStarting: (id: string, generation: number) => { const key = `${id}:${generation}`; held.add(key); return () => held.delete(key); } };
  const run = compile(`
    ${helpers}
    const steps = [];
    ${hold}
    const releaseStarting = takeStartingHold(bot.id);
    takeStartingHold(bot.id)();
    steps.push(["claim released", held.size]);
    try { await dispatch(); steps.push(["accepted", held.size]); } catch { steps.push(["refused", held.size]); } finally { releaseStarting(); }
    steps.push(["settled", held.size]);
    ${hold}
    takeStartingHold(bot.id)();
    steps.push(["early exit", held.size]);
    return steps;`);
  const scope = (dispatch: () => Promise<unknown>) => ({ accountRuntime, held, dispatch, bot: { id: "atlas" }, instanceId: "acct_studio", instance: { account: { generation: 3 } } });
  expect(await run(scope(async () => ({ turnId: "t" })))).toEqual([["claim released", 1], ["accepted", 1], ["settled", 0], ["early exit", 0]]);
  expect(await run(scope(() => Promise.reject(new Error("provider unavailable"))))).toEqual([["claim released", 1], ["refused", 1], ["settled", 0], ["early exit", 0]]);
});

it("records each quota update path exactly once", async () => {
  expect(count(source, "usageBoard.recordReport(")).toBe(7);
  const direct = [...source.matchAll(/rateLimitsByInstance\.set\(([^,]+), ([^)]+?)\);\n(\s+)scheduleSaveRateLimits\(rateLimitsByInstance, DATA_DIR\);\n\s+usageBoard\.recordReport\(([^,]+), ([^)]+?)\);/g)];
  expect(direct.map((match) => [match[1] === match[4], match[2] === match[5]])).toEqual(Array(4).fill([true, true]));
  const spawnSave = section("  save: (id, report) => { scheduleSaveRateLimits", "\n", section("const spawnUsage = createSpawnUsage({", "\n});"));
  expect(section("const spawnUsage = createSpawnUsage({", "\n});")).toContain(spawnSave);
  const usageSave = section("save: (id, report) => { saveRateLimits", " }),");
  expect(section("  usage: createAccountUsage({", "\n});")).toContain(usageSave);
  const invalidation = section("saveRateLimits: () => {", "}");
  for (const save of [spawnSave, usageSave]) expect(count(save, "usageBoard.recordReport(id, report)")).toBe(1);
  expect(count(section("const refreshSwappedUsage = createUsageSwapRefresh({", "\n});"), "usageBoard.recordReport(id, report)")).toBe(1);
  expect(invalidation).not.toContain("recordReport");
  for (const [path, call] of [["./spawn-usage.ts", "deps.save(instanceId, result.report);"], ["./account-updates.ts", "deps.save(id, result.report);"]]) {
    expect(count(read(path), call)).toBe(1);
  }

  const usageBoard = { recordReport: vi.fn(), touch: vi.fn() };
  const rateLimitsByInstance = new Map();
  const event = section(`  if (event.type === "account.rate-limits.updated" && event.providerInstanceId) {`, "\n  }\n");
  const onEvent = compile(`${event}\n  }`);
  const scope = { rateLimitsByInstance, scheduleSaveRateLimits: vi.fn(), saveRateLimits: vi.fn(), DATA_DIR: "", usageBoard };
  const updated = (observedAt: string, usedPercent: number) => ({ type: "account.rate-limits.updated", providerInstanceId: "acct_studio", windows: report(usedPercent).windows, observedAt, createdAt: observedAt });
  await onEvent({ ...scope, event: updated("2026-11-05T10:00:00.000Z", 40) });
  await onEvent({ ...scope, event: updated("2026-11-05T09:00:00.000Z", 10) });
  expect(usageBoard.recordReport).toHaveBeenCalledExactlyOnceWith("acct_studio", rateLimitsByInstance.get("acct_studio"));

  usageBoard.recordReport.mockClear();
  const saves = await compile(`return [{ ${spawnSave} }.save, { ${usageSave} }.save, { ${invalidation}} }.saveRateLimits];`)(scope);
  saves[0]("claude", report(20));
  saves[1]("acct_studio", report(30));
  saves[2]();
  expect(usageBoard.recordReport.mock.calls).toEqual([["claude", report(20)], ["acct_studio", report(30)]]);
  expect(usageBoard.touch).toHaveBeenCalledOnce();
});

it("renders one name on every surface", async () => {
  const spawnName = section("  nameOf: (id, engine) => accountNames.nameOf(id, engine),", "\n");
  expect(section("const spawnUsage = createSpawnUsage({", "\n});")).toContain(spawnName);
  expect(section("const workerLaunch = createWorkerLaunch({", "\n});")).toContain("nameOf: (id, engine) => accountNames.nameOf(id, engine)");
  expect(section("const accountRoutes = createAccountRoutes(", "\n});")).toContain("names: accountNames, onNamesChanged: () => { usageBoard.touch(); void accountUpdates(); }");
  const env = compile(`return { ${section("      OMB_ACCOUNT_NAMES:", "\n", section("function terminalIntegration(", "\n}\n"))} }.OMB_ACCOUNT_NAMES;`);
  const paneName = section("{ nameOf: (account) =>", " }, args)", read("./drivers/terminal-proxy.ts")).slice("{ nameOf: ".length);
  const { createSpawnUsage } = await import("./spawn-usage.ts");
  const { createAccountNotices } = await import("./account-notice.ts");
  const { terminalSnapshotText } = await import("./drivers/terminal-proxy.ts");
  const s = await wired("acct_studio");
  const nameOf = await compile(`return { ${spawnName} }.nameOf;`)(s);
  const notices = createAccountNotices({
    names: s.accountNames, sync: () => s.accountNames.sync(s.accounts.list()), schedule: queueMicrotask,
    runs: async () => ({ known: true, runs: [{ botId: "atlas", paneId: "p1", label: "ATLAS-1", engine: "claude", accountId: "claude", accountGeneration: 0, state: "busy" }] }),
  });
  s.rateLimitsByInstance.set("acct_studio", report(40, new Date().toISOString()));
  const spawnUsage = createSpawnUsage({ rateLimits: s.rateLimitsByInstance, save() {}, refresh: async () => ({}), environment: () => ({}), nameOf });
  let seq = 0;

  const surfaces = async () => {
    const panesNameOf = await compile(`return ${paneName};`)({ ACCOUNT_NAMES: JSON.parse(await env(s)) });
    const panes = terminalSnapshotText({ state: "ready", sessionId: "s1", generation: 1, panes: [{ sessionId: "p1", generation: 1, label: "ATLAS-2", account: { id: "acct_studio", generation: 3 } }] } as never, panesNameOf);
    notices.mainChanged({ base: "claude", engine: "claude", from: { id: "claude", generation: 0 }, to: { id: "acct_studio", generation: 3 }, seq: ++seq });
    await new Promise((resolve) => setImmediate(resolve));
    const note = notices.forTurn("atlas");
    note.commit();
    notices.forget("atlas");
    const spawn = await spawnUsage("atlas", "ATLAS-2", "claude", { id: "acct_studio", name: "Claude", generation: 3 });
    const board = (await s.usageBoard.read()).engines[0].accounts.find((account: { id: string }) => account.id === "acct_studio");
    return { spawn: spawn.line, panes: panes.split("\n").find((line) => line.includes("ATLAS-2")), note: note.text, board: board.name };
  };

  const plain = await surfaces();
  expect(plain.spawn).toMatch(/^Claude 2 usage left: /);
  expect(plain.panes).toMatch(/ · on Claude 2$/);
  expect(plain.note).toContain("Claude Main is now Claude 2 (was Claude 1).");
  expect(plain.board).toBe("Claude 2");

  s.accountNames.setNickname("acct_studio", "Studio");
  const named = await surfaces();
  expect(named.spawn).toMatch(/^Studio usage left: /);
  expect(named.panes).toMatch(/ · on Studio$/);
  expect(named.note).toContain("Claude Main is now Studio (was Claude 1).");
  expect(named.board).toBe("Studio");
});
