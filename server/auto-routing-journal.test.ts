import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { userChoice } from "./auto-routing-attrib.ts";
import { AutoRoutingRuntime, type AutoWorkerCandidate, type AutoWorkerTurn } from "./auto-routing-runtime.ts";
import { createAutoRoutingService } from "./auto-routing-service.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

const route = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "high" as const, account: "codex", generation: 0, tier: "strong" as const };
const dimensions = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "high" as const };
const task = { kind: "build" as const, risk: "low" as const, scope: "bounded" as const, source: "declared" as const };
const FILES = ["auto-routing-state.json", "auto-routing-habits.json", "auto-routing-rules.json"];

function candidate(usedPercent = 20): AutoWorkerCandidate {
  return { engine: "codex", account: "codex", generation: 0, currentGeneration: 0, authorized: true, signedIn: true, lifecycle: "ready", subscription: true,
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"], effortLevels: ["low", "medium", "high", "xhigh"], tools: ["files"], contextTokens: 100000,
    usage: { observedAt: new Date().toISOString(), windows: [{ id: "five_hour", usedPercent, resetsAt: null }] }, externalActive: 0, loadKnown: true, headroom: 80, main: true };
}

function fixture() {
  const dir = join(DATA_DIR, randomUUID());
  const disk = { journal: false, stores: false, usedPercent: 20 };
  const write: typeof writeFileAtomic = (path, data, options) => {
    if (path.endsWith("auto-routing-journal.json") ? disk.journal : disk.stores) throw new Error("disk failure");
    writeFileAtomic(path, data, options);
  };
  const store = new Store(() => ({ instanceId: "codex", model: "gpt-6.1-sol" }));
  const bot = store.createBot();
  const service = createAutoRoutingService(dir, store, write);
  service.setEnabled(bot.id, true);
  const live: { turn?: AutoWorkerTurn } = {};
  const say = (text: string) => {
    const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
    const id = randomUUID();
    turnRegistry.start(id, { botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0, userKeys: [message.id] });
    live.turn = { id, threadId: bot.threadId };
  };
  const pick = () => service.state.pick(bot.id, bot.threadId, bot.threadId);
  const saved = () => FILES.map((name) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  const change = () => service.state.get(bot.id)?.pickChanges?.[bot.threadId]?.id ?? "";
  const pinned = () => {
    say("Use Sol high");
    const attributed = userChoice(service.source(bot.id, bot.threadId), "worker", "build", "Sol high", dimensions)!;
    service.spawnPin(bot.id, bot.threadId, route, attributed.choice, attributed.context);
    return change();
  };
  const workers = () => {
    const runtime = new AutoRoutingRuntime(dir, { enabled: () => true, turn: () => live.turn, source: () => service.source(bot.id, bot.threadId),
      rules: () => service.rules.current(), candidates: () => [candidate(disk.usedPercent)], valid: () => true, refresh: vi.fn(async () => {}),
      events: { decision: vi.fn(() => true), outcome: vi.fn(() => true) }, transaction: service.transaction, habit: service.habit,
      observe: (botId, turn, chosen, choice, context) => service.spawnPin(botId, turn.threadId!, chosen, choice, context) }, service.write);
    service.register(runtime);
    return runtime;
  };
  return { dir, disk, store, bot, service, live, say, pick, saved, change, pinned, workers };
}
const journal = (f: ReturnType<typeof fixture>) => join(f.dir, "auto-routing-journal.json");

describe("Auto cross-store journal", () => {
  it("keeps undo atomic when the journal write fails, then retries", () => {
    const f = fixture();
    const id = f.pinned();
    const before = f.saved();
    f.disk.journal = true;
    expect(() => f.service.undo(f.bot.id, f.bot.threadId, id)).toThrow("disk failure");
    expect(f.pick()).toEqual(dimensions);
    expect(f.service.habits.rows()).toHaveLength(1);
    expect(f.saved()).toEqual(before);
    f.disk.journal = false;
    expect(f.service.undo(f.bot.id, f.bot.threadId, id)).toEqual({ applied: true });
    expect(f.pick()).toBeUndefined();
    expect(f.service.habits.rows()).toEqual([]);
    expect(existsSync(journal(f))).toBe(false);
  });

  it("replays both stores on restart after a crash past the journal write", () => {
    const f = fixture();
    const id = f.pinned();
    const before = f.saved();
    f.disk.stores = true;
    expect(f.service.undo(f.bot.id, f.bot.threadId, id)).toEqual({ applied: true });
    expect(f.pick()).toBeUndefined();
    expect(f.saved()).toEqual(before);
    expect(existsSync(journal(f))).toBe(true);
    const restored = createAutoRoutingService(f.dir, f.store);
    expect(restored.state.pick(f.bot.id, f.bot.threadId, f.bot.threadId)).toBeUndefined();
    expect(restored.habits.rows()).toEqual([]);
    expect(existsSync(journal(f))).toBe(false);
  });

  it("replays an old journal before newer data so it cannot overwrite it", () => {
    const f = fixture();
    const id = f.pinned();
    f.disk.stores = true;
    f.service.undo(f.bot.id, f.bot.threadId, id);
    expect(() => f.service.setEnabled(f.bot.id, false)).toThrow("disk failure");
    expect(f.service.state.get(f.bot.id)?.enabled).toBe(true);
    f.disk.stores = false;
    f.service.setEnabled(f.bot.id, false);
    expect(existsSync(journal(f))).toBe(false);
    const restored = createAutoRoutingService(f.dir, f.store);
    expect(restored.state.get(f.bot.id)?.enabled).toBe(false);
    expect(restored.state.pick(f.bot.id, f.bot.threadId, f.bot.threadId)).toBeUndefined();
    expect(restored.habits.rows()).toEqual([]);
  });

  it("keeps forgetHabits and its rule change atomic", () => {
    const f = fixture();
    f.pinned();
    f.say("forget my habits");
    const before = f.saved();
    f.disk.journal = true;
    expect(f.service.tool(f.bot.id, f.bot.threadId, { op: "forgetHabits", quote: "forget my habits" })).toMatchObject({ applied: false });
    expect(f.service.habits.rows()).toHaveLength(1);
    expect(f.service.rules.lastChange()).toBeUndefined();
    expect(f.saved()).toEqual(before);
    f.disk.journal = false;
    expect(f.service.tool(f.bot.id, f.bot.threadId, { op: "forgetHabits", quote: "forget my habits" })).toEqual({ applied: true });
    expect(f.service.habits.rows()).toEqual([]);
    expect(f.service.rules.lastChange()).toBeDefined();
    expect(createAutoRoutingService(f.dir, f.store).habits.rows()).toEqual([]);
  });

  it("keeps a rule undo atomic and retries it", () => {
    const f = fixture();
    f.say("Sonnet high for searches");
    const rule = { op: "setPreference", target: "worker", taskClass: "research", model: "claude-sonnet-5-5", effort: "high", quote: "Sonnet high" };
    expect(f.service.tool(f.bot.id, f.bot.threadId, rule)).toEqual({ applied: true });
    const id = f.service.rules.lastChange()!.id;
    const before = f.service.rules.current();
    f.disk.journal = true;
    expect(() => f.service.undo(f.bot.id, f.bot.threadId, id)).toThrow("disk failure");
    expect(f.service.rules.current()).toEqual(before);
    f.disk.journal = false;
    expect(f.service.undo(f.bot.id, f.bot.threadId, id)).toEqual({ applied: true });
    expect(f.service.rules.current()).toEqual({ id: 2, content: { max: false, preferences: [] } });
  });

  it("emits the chat row only after the commit", () => {
    const f = fixture();
    const id = f.pinned();
    const rows = () => f.store.messagesFor(f.bot.threadId).filter((line) => line.autoChange).length;
    const count = rows();
    f.disk.journal = true;
    expect(() => f.service.undo(f.bot.id, f.bot.threadId, id)).toThrow("disk failure");
    expect(rows()).toBe(count);
    f.disk.journal = false;
    f.service.undo(f.bot.id, f.bot.threadId, id);
    expect(rows()).toBe(count + 1);
  });

  it("reloads every registered store when a transaction throws", () => {
    const f = fixture();
    const runtime = f.workers();
    const reload = vi.spyOn(runtime, "reload");
    expect(() => f.service.transaction(() => { f.service.setEnabled(f.bot.id, false); throw new Error("boom"); })).toThrow("boom");
    expect(f.service.state.get(f.bot.id)?.enabled).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves no pick, reservation or habit after a failed spawn transaction", async () => {
    const f = fixture();
    const runtime = f.workers();
    f.say("Use Sol high");
    const request = { requestId: randomUUID(), botId: f.bot.id, task, pin: { model: "gpt-6.1-sol", effort: "high" as const, userQuote: "Sol high" } };
    const before = f.saved();
    f.disk.journal = true;
    await expect(runtime.prepare(request, async () => "argv")).rejects.toThrow("disk failure");
    expect(f.pick()).toBeUndefined();
    expect(f.service.habits.rows()).toEqual([]);
    expect(runtime.rows()).toEqual([]);
    expect(runtime.candidates()[0]).toMatchObject({ pending: 0 });
    expect(f.saved()).toEqual(before);
    expect(JSON.parse(readFileSync(join(f.dir, "auto-routing-workers.json"), "utf8")).rows).toEqual([]);
    f.disk.journal = false;
    expect((await runtime.prepare(request, async () => "argv")).kind).toBe("ready");
    expect(f.pick()).toEqual(dimensions);
    expect(f.service.habits.rows()).toHaveLength(1);
    expect(runtime.rows()).toHaveLength(1);
  });

  it("changes nothing on a hold", async () => {
    const f = fixture();
    const runtime = f.workers();
    f.say("Use Sol high");
    const request = { requestId: randomUUID(), botId: f.bot.id, task, pin: { model: "gpt-6.1-sol", effort: "high" as const, userQuote: "Sol high" } };
    const before = f.saved();
    f.disk.usedPercent = 90;
    const prepare = vi.fn(async () => "argv");
    expect((await runtime.prepare(request, prepare)).kind).toBe("hold");
    expect(prepare).not.toHaveBeenCalled();
    expect(f.pick()).toBeUndefined();
    expect(f.service.state.get(f.bot.id)?.pickChanges).toBeUndefined();
    expect(f.service.habits.rows()).toEqual([]);
    expect(runtime.rows()).toEqual([]);
    expect(f.saved()).toEqual(before);
  });
});
