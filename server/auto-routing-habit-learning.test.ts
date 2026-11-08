import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { userChoice } from "./auto-routing-attrib.ts";
import { AutoRoutingRuntime, type AutoWorkerCandidate, type AutoWorkerTurn } from "./auto-routing-runtime.ts";
import { createAutoRoutingService } from "./auto-routing-service.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

const DAY = 24 * 60 * 60_000;
const task = { kind: "build" as const, risk: "low" as const, scope: "bounded" as const, source: "declared" as const };
const terra = { engine: "codex" as const, model: "gpt-6.1-terra", effort: "medium" as const };
const sol = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "high" as const };
const pin = { model: "gpt-6.1-terra", effort: "medium" as const, userQuote: "Terra medium" };

function candidate(): AutoWorkerCandidate {
  return { engine: "codex", account: "codex", generation: 0, currentGeneration: 0, authorized: true, signedIn: true, lifecycle: "ready", subscription: true,
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"], effortLevels: ["low", "medium", "high", "xhigh"], tools: ["files"], contextTokens: 100000,
    usage: { observedAt: new Date(Date.now()).toISOString(), windows: [{ id: "five_hour", usedPercent: 20, resetsAt: null }] }, externalActive: 0, loadKnown: true, headroom: 80, main: true };
}

function fixture(keptPicks = false) {
  const dir = join(DATA_DIR, randomUUID());
  const store = new Store(() => ({ instanceId: "codex", model: "gpt-6.1-sol" }));
  const bot = store.createBot();
  const service = createAutoRoutingService(dir, store);
  service.setEnabled(bot.id, true);
  const live: { turn?: AutoWorkerTurn } = {};
  const say = (text: string) => {
    const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
    const id = randomUUID();
    turnRegistry.start(id, { botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0, userKeys: [message.id] });
    live.turn = { id, threadId: bot.threadId };
  };
  const decision = vi.fn((..._args: unknown[]) => true);
  const runtime = new AutoRoutingRuntime(dir, { enabled: () => true, turn: () => live.turn, source: () => service.source(bot.id, bot.threadId),
    rules: () => service.rules.current(), candidates: () => [candidate()], valid: () => true, refresh: vi.fn(async () => {}),
    events: { decision, outcome: vi.fn(() => true) }, transaction: service.transaction, habit: service.habit,
    observe: (botId, turn, route, choice, context) => service.spawnPin(botId, turn.threadId!, route, choice, context),
    ...(keptPicks ? { kept: (botId: string, turn: AutoWorkerTurn) => service.state.pick(botId, turn.threadId!, turn.threadId!),
      bind: (botId: string, turn: AutoWorkerTurn, route: Parameters<typeof service.bindPick>[2], taskClass: Parameters<typeof service.bindPick>[3]) => service.bindPick(botId, turn.threadId!, route, taskClass) } : {}) }, service.write);
  service.register(runtime);
  const prepare = async (pinned?: typeof pin | { model: string; userQuote: string }) => {
    const result = await runtime.prepare({ requestId: randomUUID(), botId: bot.id, task, pin: pinned }, async () => "argv");
    if (result.kind !== "ready") return result;
    return result.row.route;
  };
  const learned = async () => { say("Use Terra medium"); return prepare(pin); };
  const change = () => service.state.get(bot.id)?.pickChanges?.[bot.threadId]?.id ?? "";
  return { store, bot, service, runtime, say, prepare, learned, change, decision };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 20 * DAY }); });
afterEach(() => { vi.useRealTimers(); });

describe("worker habit learning", () => {
  it("applies a habit to selection only after three pins across two days", async () => {
    const f = fixture();
    await f.learned();
    await f.learned();
    expect(f.service.habit("build", Date.now())).toBeUndefined();
    expect(await f.prepare()).toMatchObject(sol);
    vi.setSystemTime(Date.now() + 2 * DAY);
    await f.learned();
    expect(f.service.habit("build", Date.now())).toMatchObject({ target: "worker", taskClass: "build", ...terra });
    expect(f.service.habits.preference("chat", "build", Date.now())).toBeUndefined();
    expect(await f.prepare()).toMatchObject(terra);
    expect(f.decision.mock.calls.at(-1)?.[1]).toMatchObject({ reason: "habit" });
  });

  it("drops the habit row on undo and stops applying it", async () => {
    const f = fixture();
    await f.learned();
    await f.learned();
    vi.setSystemTime(Date.now() + 2 * DAY);
    await f.learned();
    const id = f.change();
    expect(f.service.habits.rows().map((row) => row.choiceId)).toContain(id);
    expect(f.service.undo(f.bot.id, f.bot.threadId, id)).toEqual({ applied: true });
    expect(f.service.habits.rows().map((row) => row.choiceId)).not.toContain(id);
    expect(f.service.habit("build", Date.now())).toBeUndefined();
    expect(await f.prepare()).toMatchObject(sol);
  });

  it("never learns an unverified pin", async () => {
    const f = fixture();
    f.say("Use Sol");
    expect(await f.prepare(pin)).toEqual({ kind: "hold", reason: "unverified-pin" });
    expect(f.service.habits.rows()).toEqual([]);
    const attributed = userChoice(f.service.source(f.bot.id, f.bot.threadId), "worker", "build", "Sol", { model: "gpt-6.1-sol", engine: "codex" })!;
    f.service.spawnPin(f.bot.id, f.bot.threadId, { ...sol, account: "codex", generation: 0, tier: "strong" }, attributed.choice, { ...attributed.context, authorized: false });
    expect(f.service.habits.rows()).toEqual([]);
    expect(f.service.state.pick(f.bot.id, f.bot.threadId, f.bot.threadId)).toBeUndefined();
  });

  it("fills an unnamed dimension from the route and keeps the pick as named", async () => {
    const f = fixture();
    f.say("Use Sol");
    await f.prepare({ model: "gpt-6.1-sol", userQuote: "Sol" });
    expect(f.service.habits.rows()).toEqual([expect.objectContaining({ ...sol, target: "worker", taskClass: "build", choiceId: f.change() })]);
    expect(f.service.state.pick(f.bot.id, f.bot.threadId, f.bot.threadId)).toEqual({ engine: "codex", model: "gpt-6.1-sol" });
  });

  it("binds a kept auto_rule pick once to the next request", async () => {
    const f = fixture(true);
    f.say("Use Terra medium");
    expect(f.service.tool(f.bot.id, f.bot.threadId, { op: "pick", target: "worker", model: "gpt-6.1-terra", effort: "medium", quote: "Terra medium" })).toEqual({ applied: true });
    const id = f.change();
    expect(await f.prepare()).toMatchObject(terra);
    expect(await f.prepare()).toMatchObject(terra);
    expect(f.service.habits.rows()).toEqual([expect.objectContaining({ ...terra, taskClass: "build", choiceId: id })]);
    f.service.undo(f.bot.id, f.bot.threadId, id);
    expect(f.service.habits.rows()).toEqual([]);
  });
});
