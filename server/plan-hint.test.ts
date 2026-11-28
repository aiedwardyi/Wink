import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInternalRoutes, PLAN_HINT } from "./internal-routes.ts";
import { sharedTurn } from "./rooms/guards.ts";
import type { BotRecord, Store } from "./store.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";
import { turnRegistry } from "./turn-registry.ts";

type StartOpts = { cardContinuation?: boolean; paneNoteWake?: boolean; keepGoingWake?: boolean; automationSource?: string; commsDepth?: number };

const BOT = { id: "rosa", threadId: "tr", name: "Rosa" } as BotRecord;
const GROUP = "tg";
const steps = (open: number, done = 0) => [
  ...Array.from({ length: done }, (_, i) => ({ step: `done ${i}`, status: "done" })),
  ...Array.from({ length: open }, (_, i) => ({ step: `step ${i}`, status: i ? "pending" : "active" })),
];

let packets: Map<string, TaskResumePacket>;
let panes: number | null;
let ready: boolean;
let readOnly: boolean;
let route: ReturnType<typeof createInternalRoutes>;

beforeEach(() => {
  packets = new Map([BOT.threadId, GROUP].map((threadId) => [threadId, seedTaskResumePacket({ threadId, botId: BOT.id, text: "Build the site", messageId: "m", now: 1, turnsAtWrite: 0 })]));
  panes = 0;
  ready = true;
  readOnly = false;
  const store = {
    bot: () => BOT,
    conversationForBot: () => ({}),
    taskByThread: () => undefined,
    groupTaskByThread: () => undefined,
    groupByThread: (threadId: string) => (threadId === GROUP ? {} : undefined),
  } as unknown as Store;
  route = createInternalRoutes({
    store,
    taskPacketForWrite: (threadId: string) => structuredClone(packets.get(threadId)!),
    persistTaskPacket: (next: TaskResumePacket) => (packets.set(next.threadId, next), next),
    readOnlyTurn: () => readOnly,
    planHint: { room: sharedTurn(store, new Set()), workerReady: () => ready, livePanes: async () => panes },
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
});

afterEach(() => {
  for (const threadId of [BOT.threadId, GROUP]) {
    const turn = turnRegistry.current(threadId);
    if (turn) turnRegistry.settle(turn.turnId);
  }
});

const userTurn = (turnId = "t1", threadId = BOT.threadId) => turnRegistry.start(turnId, { botId: BOT.id, threadId, owner: "user", depth: 0, helperHint: true });

async function savePlan(plan: unknown[], threadId = BOT.threadId): Promise<{ status: number; notice: string }> {
  let status = 0;
  let body = "";
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  const pending = route.taskState(req, res);
  req.emit("data", JSON.stringify({ fromBotId: BOT.id, fromThreadId: threadId, plan }));
  req.emit("end");
  await pending;
  return { status, notice: String(JSON.parse(body).notice ?? "") };
}

describe("plan-save helper hint", () => {
  it("rides a 3+ open step plan saved on a user turn with no live pane", async () => {
    userTurn();
    expect(await savePlan(steps(3, 2))).toEqual({ status: 200, notice: PLAN_HINT });
    expect(PLAN_HINT).toBe("This plan is big: write a card and hand it to a helper (terminal_playbook) before the first edit.");
  });

  it("fires once per turn and again on the next user turn", async () => {
    userTurn("t1");
    expect((await savePlan(steps(4))).notice).toBe(PLAN_HINT);
    expect((await savePlan(steps(4))).notice).toBe("");
    userTurn("t2");
    expect((await savePlan(steps(4))).notice).toBe(PLAN_HINT);
  });

  it("skips plans under 3 open steps", async () => {
    userTurn();
    expect((await savePlan(steps(2, 5))).notice).toBe("");
  });

  it("skips routine, pane-note and peer turns", async () => {
    turnRegistry.start("routine", { botId: BOT.id, threadId: BOT.threadId, owner: "user", depth: 0, helperHint: false });
    expect((await savePlan(steps(3))).notice).toBe("");
    turnRegistry.start("peer", { botId: BOT.id, threadId: BOT.threadId, owner: "peer", depth: 1 });
    expect((await savePlan(steps(3))).notice).toBe("");
  });

  it("skips room turns", async () => {
    userTurn("t1", GROUP);
    expect((await savePlan(steps(3), GROUP)).notice).toBe("");
  });

  it("skips read-only turns", async () => {
    userTurn();
    readOnly = true;
    expect((await savePlan(steps(3))).status).toBe(403);
  });

  it("skips a bot with a live pane, an unknown pane count, or no signed-in worker engine", async () => {
    for (const [count, signedIn] of [[1, true], [null, true], [0, false]] as const) {
      panes = count;
      ready = signedIn;
      userTurn(`t-${count}-${signedIn}`);
      expect((await savePlan(steps(3))).notice).toBe("");
    }
  });

  it("is about 25 tokens, on a plan save only", () => {
    expect(Math.ceil(PLAN_HINT.length / 4)).toBeLessThanOrEqual(25);
  });
});

describe("plan-save helper hint wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("marks only typed user turns with the terminal mounted", () => {
    expect(source).toContain("rootId, docFix: verifyDoc.fixTurn(bot.id, threadId, text), helperHint: turnStartedByUser(opts) && Boolean(integrations.terminal), importMemory: importOpen });");
    const start = source.indexOf("function turnStartedByUser");
    const end = source.indexOf("const SHOW_IMAGE_GUIDANCE", start);
    if (start < 0 || end < start) throw new Error("index.ts no longer has turnStartedByUser before SHOW_IMAGE_GUIDANCE; update this slice");
    // SAFETY: the code is index.ts's own turnStartedByUser, only stripped of types.
    const typed = runInNewContext(`${ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText}turnStartedByUser`) as (opts: StartOpts) => boolean;
    expect(typed({})).toBe(true);
    for (const opts of [{ automationSource: "schedule" }, { cardContinuation: true, paneNoteWake: true }, { cardContinuation: true, keepGoingWake: true }, { commsDepth: 1 }]) expect(typed(opts)).toBe(false);
    expect(source.slice(source.indexOf('owner: "room"') - 200, source.indexOf('owner: "room"') + 300)).not.toContain("helperHint");
  });

  it("checks rooms, worker engines and live panes the way the server does", () => {
    expect(source).toContain("planHint: { room: sharedTurn(store, joinedRoomThreads), workerReady: workerEngineSignedIn, livePanes: botLivePanes },");
    expect(source).toContain("  livePanes: botLivePanes,");
  });
});
