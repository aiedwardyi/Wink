import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { CommsCallers } from "./comms-caller.ts";
import { createInternalRoutes } from "./internal-routes.ts";

import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { cancelWake, setWake, syncAskWakes, WAKE_MAX_PENDING } from "./self-wake.ts";
import type { TaskAsk } from "./task-asks.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const START = Date.UTC(2026, 10, 14, 1, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-self-wake-"));
  dirs.push(dir);
  const file = join(dir, "routines.json");
  let now = START;
  const fired: Array<{ botId: string; threadId: string; line: string }> = [];
  const emitted: any[] = [];
  const options = (): RoutineManagerOptions => ({
    file,
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => "ready",
    createTask: () => ({ threadId: "detached" }),
    startTurn: async () => { throw new Error("a wake never runs detached"); },
    startChatTurn: async (run, line) => { fired.push({ botId: run.botId, threadId: run.sourceThreadId!, line }); },
    onRunChanged: (run) => ({ threadId: run.sourceThreadId ?? "bot-chat", messageId: `card-${run.id}` }),
  });
  let manager = new RoutineManager(options());
  return {
    get manager() { return manager; },
    fired,
    emitted,
    setNow: (value: number) => (now = value),
    restart: () => { manager.stop(); manager = new RoutineManager(options()); return manager; },
  };
}

const wake = (h: ReturnType<typeof harness>, at: string, note = "resume the deploy check", botId = "bot-1", threadId = "chat-7") =>
  setWake(h.manager, { botId, threadId, at, note }, START);

describe("self-wake", () => {
  it("validates the time window, the offset and the note", () => {
    const h = harness();
    expect(wake(h, iso(START + 30_000))).toMatchObject({ ok: false });
    expect(wake(h, iso(START + 8 * 24 * 60 * 60_000))).toMatchObject({ ok: false });
    expect(wake(h, "2026-11-14T03:45:00")).toMatchObject({ ok: false });
    expect(wake(h, iso(START + 5 * 60_000), "x".repeat(501))).toMatchObject({ ok: false });
    expect(wake(h, iso(START + 5 * 60_000), "  ")).toMatchObject({ ok: false });
    expect(setWake(h.manager, { botId: "bot-1", threadId: "chat-7", at: "2026-11-31T01:00:00Z", note: "n" }, Date.UTC(2026, 10, 28))).toMatchObject({ ok: false });
    expect(wake(h, "2026-11-14T24:30:00+09:00")).toMatchObject({ ok: false });
    const ok = wake(h, "2026-11-14T10:15:00+09:00");
    expect(ok).toMatchObject({ ok: true, at: Date.UTC(2026, 10, 14, 1, 15) });
    if (ok.ok) expect(ok.local).toBeTruthy();
  });

  it("wakes the same bot in the same chat once, as an automated wake with its note", async () => {
    const h = harness();
    const set = wake(h, iso(START + 10 * 60_000));
    expect(set.ok).toBe(true);
    h.setNow(START + 9 * 60_000);
    await h.manager.tick();
    expect(h.fired).toEqual([]);
    h.setNow(START + 10 * 60_000 + 5_000);
    await h.manager.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatchObject({ botId: "bot-1", threadId: "chat-7" });
    expect(h.fired[0]!.line).toMatch(/^\[Wake\]/);
    expect(h.fired[0]!.line).toContain("resume the deploy check");
    expect(h.fired[0]!.line).not.toMatch(/late/i);
    expect(h.manager.listRoutines()).toEqual([]);
    await h.manager.tick();
    h.restart();
    await h.manager.tick();
    expect(h.fired).toHaveLength(1);
  });

  it("survives a restart and fires a wake missed while off once, marked late", async () => {
    const h = harness();
    expect(wake(h, iso(START + 60 * 60_000)).ok).toBe(true);
    h.setNow(START + 3 * 24 * 60 * 60_000);
    h.restart();
    await h.manager.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.line).toMatch(/late/i);
    const run = h.manager.listRuns()[0]!;
    expect(run.status).not.toBe("missed");
    h.restart();
    await h.manager.tick();
    expect(h.fired).toHaveLength(1);
  });

  it("never saves its queued run while the wake is still pending", async () => {
    const h = harness();
    expect(wake(h, iso(START + 5 * 60_000)).ok).toBe(true);
    const file = join(dirs[0]!, "routines.json");
    const onDisk: Array<{ routines: unknown[]; runs: unknown[] }> = [];
    h.emitted.push = (payload: any) => {
      if (payload.kind === "routine.run") onDisk.push(JSON.parse(readFileSync(file, "utf8")));
      return 0;
    };
    h.setNow(START + 6 * 60_000);
    await h.manager.tick();
    expect(onDisk.length).toBeGreaterThan(0);
    for (const snapshot of onDisk) expect(snapshot.runs.length > 0 && snapshot.routines.length > 0).toBe(false);
  });

  it("sets and cancels wakes only as the bot its token belongs to", async () => {
    const h = harness();
    const callers = new CommsCallers();
    const routes = createInternalRoutes({
      store: { bot: (id: string) => ({ id }) },
      connectorThread: () => ({}),
      routines: h.manager,
      resolveCommsCaller: (header: string | string[] | undefined) => callers.resolve(header),
    } as unknown as Parameters<typeof createInternalRoutes>[0]);
    const post = async (body: object) => {
      const req = new EventEmitter() as IncomingMessage;
      req.headers = { authorization: `Bearer ${callers.token("bot-a", "chat-a")}` };
      let out = "";
      const res = { writeHead() {}, getHeader() {}, setHeader() {}, end(value: string) { out = value; } } as unknown as ServerResponse;
      const pending = routes.wake(req, res);
      req.emit("data", JSON.stringify(body));
      req.emit("end");
      await pending;
      return JSON.parse(out);
    };
    const set = await post({ fromBotId: "bot-b", fromThreadId: "chat-b", at: new Date(Date.now() + 5 * 60_000).toISOString(), note: "spoofed" });
    expect(h.manager.listRoutines().map((r) => [r.botId, r.sourceThreadId])).toEqual([["bot-a", "chat-a"]]);
    const other = setWake(h.manager, { botId: "bot-b", threadId: "chat-b", at: iso(START + 5 * 60_000), note: "b's own" }, START);
    if (!other.ok) throw new Error(other.error);
    expect((await post({ fromBotId: "bot-b", fromThreadId: "chat-b", cancel: other.id })).error).toBeTruthy();
    expect(h.manager.listRoutines()).toHaveLength(2);
    expect((await post({ cancel: set.id })).ok).toBe(true);
  });

  it("caps pending wakes per bot", () => {
    const h = harness();
    for (let i = 0; i < WAKE_MAX_PENDING; i++) expect(wake(h, iso(START + (5 + i) * 60_000)).ok).toBe(true);
    const eleventh = wake(h, iso(START + 30 * 60_000));
    expect(eleventh).toMatchObject({ ok: false });
    if (!eleventh.ok) expect(eleventh.error).toContain("10");
    expect(wake(h, iso(START + 30 * 60_000), "other bot", "bot-2").ok).toBe(true);
  });

  it("cancels only the bot's own pending wake", async () => {
    const h = harness();
    const set = wake(h, iso(START + 5 * 60_000));
    if (!set.ok) throw new Error(set.error);
    expect(cancelWake(h.manager, "bot-2", set.id)).toBe(false);
    expect(cancelWake(h.manager, "bot-1", set.id)).toBe(true);
    expect(cancelWake(h.manager, "bot-1", set.id)).toBe(false);
    h.setNow(START + 6 * 60_000);
    await h.manager.tick();
    expect(h.fired).toEqual([]);
  });

  it("wakes the bot once when an open ask's due time passes and never for a closed one", async () => {
    const h = harness();
    const chat = { botId: "bot-1", threadId: "chat-7" };
    const due = START + 10 * 60_000;
    const asks: TaskAsk[] = [
      { id: "A1", ask: "phone Model Index designs", status: "open", due, at: START, changedAt: START },
      { id: "A2", ask: "ship the fix", status: "open", due, at: START, changedAt: START },
    ];
    expect(syncAskWakes(h.manager, chat, [], asks, START)).toEqual([]);
    expect(h.manager.listRoutines()).toHaveLength(2);
    const closed = asks.map((item) => item.id === "A2" ? { ...item, status: "done" as const } : { ...item });
    syncAskWakes(h.manager, chat, asks, closed, START + 60_000);
    expect(h.manager.listRoutines()).toHaveLength(1);
    h.setNow(due + 5_000);
    await h.manager.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatchObject(chat);
    expect(h.fired[0]!.line).toContain("A1");
    expect(h.fired[0]!.line).toContain("phone Model Index designs");
    expect(h.fired[0]!.line).not.toContain("ship the fix");
    syncAskWakes(h.manager, chat, closed, closed.map((item) => ({ ...item })), due + 10_000);
    h.setNow(due + 60 * 60_000);
    await h.manager.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.manager.listRoutines()).toEqual([]);
  });

  it("moves an ask's wake with its due time and drops it once the time is cleared", async () => {
    const h = harness();
    const chat = { botId: "bot-1", threadId: "chat-7" };
    const first: TaskAsk[] = [{ id: "A1", ask: "phone designs", status: "open", due: START + 10 * 60_000, at: START, changedAt: START }];
    syncAskWakes(h.manager, chat, [], first, START);
    const moved = [{ ...first[0]!, due: START + 30 * 60_000 }];
    syncAskWakes(h.manager, chat, first, moved, START);
    expect(h.manager.listRoutines().map((routine) => routine.nextRunAt)).toEqual([START + 30 * 60_000]);
    const { due: _, ...cleared } = moved[0]!;
    syncAskWakes(h.manager, chat, moved, [cleared], START);
    expect(h.manager.listRoutines()).toEqual([]);
    expect(syncAskWakes(h.manager, chat, [], [{ ...first[0]!, due: START + 8 * 24 * 60 * 60_000 }], START)).toEqual([
      expect.stringMatching(/^No wake for A1: at must be between 1 minute and 7 days/),
    ]);
  });

  it("cancels the wake of an ask that fell off, sets one again when a closed ask reopens before its time, and says when the time already passed", async () => {
    const h = harness();
    const chat = { botId: "bot-1", threadId: "chat-7" };
    const due = START + 10 * 60_000;
    const open: TaskAsk[] = [{ id: "A1", ask: "phone designs", status: "open", due, at: START, changedAt: START }];
    syncAskWakes(h.manager, chat, [], open, START);
    syncAskWakes(h.manager, chat, open, [], START);
    expect(h.manager.listRoutines()).toEqual([]);
    const reopen: TaskAsk[] = [{ id: "A2", ask: "ship it", status: "open", due, at: START, changedAt: START }];
    syncAskWakes(h.manager, chat, [], reopen, START);
    const closed = [{ ...reopen[0]!, status: "done" as const }];
    syncAskWakes(h.manager, chat, reopen, closed, START);
    expect(h.manager.listRoutines()).toEqual([]);
    syncAskWakes(h.manager, chat, closed, [{ ...closed[0]!, status: "open" }], START);
    h.setNow(due + 5_000);
    await h.manager.tick();
    expect(h.fired.map((fire) => fire.line)).toEqual([expect.stringContaining("Ask A2 is due")]);
    expect(syncAskWakes(h.manager, chat, [], [{ id: "A3", ask: "late one", status: "open", due: START - 60_000, at: START, changedAt: START }], START)).toEqual([
      "No wake for A3: its due time already passed.",
    ]);
  });

  it("a room member who moves or closes another member's ask cancels that member's wake", () => {
    const h = harness();
    const due = START + 10 * 60_000;
    const first: TaskAsk[] = [
      { id: "A1", ask: "phone designs", status: "open", due, at: START, changedAt: START },
      { id: "A2", ask: "ship it", status: "open", due, at: START, changedAt: START },
    ];
    syncAskWakes(h.manager, { botId: "bot-a", threadId: "room-1" }, [], first, START);
    const next = [{ ...first[0]!, due: START + 30 * 60_000 }, { ...first[1]!, status: "done" as const }];
    syncAskWakes(h.manager, { botId: "bot-b", threadId: "room-1" }, first, next, START);
    expect(h.manager.listRoutines().map((routine) => [routine.botId, routine.nextRunAt])).toEqual([["bot-b", START + 30 * 60_000]]);
  });

  it("an ask started before its due time is not told to start again", async () => {
    const h = harness();
    const chat = { botId: "bot-1", threadId: "chat-7" };
    const due = START + 10 * 60_000;
    const open: TaskAsk[] = [{ id: "A1", ask: "phone designs", status: "open", due, at: START, changedAt: START }];
    syncAskWakes(h.manager, chat, [], open, START);
    syncAskWakes(h.manager, chat, open, open.map((ask) => ({ ...ask, status: "building" as const })), START + 60_000);
    h.setNow(due + 5_000);
    await h.manager.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.line).toContain("If it isn't started, start it now; otherwise update its due time.");
  });

  it("an ask's wake outlives a restart and rings once", async () => {
    const h = harness();
    const chat = { botId: "bot-1", threadId: "chat-7" };
    const due = START + 10 * 60_000;
    const asks: TaskAsk[] = [{ id: "A1", ask: "phone designs", status: "open", due, at: START, changedAt: START }];
    syncAskWakes(h.manager, chat, [], asks, START);
    const id = asks[0]!.wake;
    h.restart();
    syncAskWakes(h.manager, chat, asks, asks.map((ask) => ({ ...ask })), START + 60_000);
    expect(h.manager.listRoutines().map((routine) => routine.id)).toEqual([id]);
    h.setNow(due + 5_000);
    await h.manager.tick();
    expect(h.fired.map((fire) => fire.line)).toEqual([expect.stringContaining("Ask A1 is due")]);
  });

  it("drops the ask wakes it set when the task record is not saved, so a retry sets one", async () => {
    const h = harness();
    const packet = { v: 1, threadId: "chat-a", botId: "bot-a", goal: "", plan: [], completed: [], evidence: [], artifacts: [], blockers: [], nextAction: "", updatedAt: 1 };
    const routes = createInternalRoutes({
      store: { bot: (id: string) => ({ id }), conversationForBot: () => ({}), taskByThread: () => undefined },
      routines: h.manager,
      taskPacketForWrite: () => packet,
      persistTaskPacket: () => null,
    } as unknown as Parameters<typeof createInternalRoutes>[0]);
    const due = new Date(Date.now() + 30 * 60_000).toISOString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const req = new EventEmitter() as IncomingMessage;
      req.headers = {};
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, getHeader() {}, setHeader() {}, end() {} } as unknown as ServerResponse;
      const pending = routes.taskState(req, res);
      req.emit("data", JSON.stringify({ fromBotId: "bot-a", fromThreadId: "chat-a", asks: [{ ask: "phone designs", status: "open", due }] }));
      req.emit("end");
      await pending;
      expect(status).toBe(409);
    }
    expect(h.manager.listRoutines()).toEqual([]);
  });

  it("never lets a wake ride a calendar routine id", () => {
    const h = harness();
    const routine = h.manager.create({ name: "Brief", prompt: "x", botId: "bot-1", schedule: { type: "once", at: START + 60 * 60_000 } });
    expect(cancelWake(h.manager, "bot-1", routine.id)).toBe(false);
    expect(h.manager.listRoutines()).toHaveLength(1);
  });
});
