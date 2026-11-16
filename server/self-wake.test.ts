import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { CommsCallers } from "./comms-caller.ts";
import { createInternalRoutes } from "./internal-routes.ts";

import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { cancelWake, setWake, WAKE_MAX_PENDING } from "./self-wake.ts";

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

  it("never lets a wake ride a calendar routine id", () => {
    const h = harness();
    const routine = h.manager.create({ name: "Brief", prompt: "x", botId: "bot-1", schedule: { type: "once", at: START + 60 * 60_000 } });
    expect(cancelWake(h.manager, "bot-1", routine.id)).toBe(false);
    expect(h.manager.listRoutines()).toHaveLength(1);
  });
});
