import type { ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import type { PrepareTurn, ProviderInstance } from "./contracts.ts";
import { createWarmPool } from "./drivers/warm-pool.ts";
import type { BotRecord } from "./store.ts";

afterEach(() => vi.useRealTimers());

function harness() {
  const bot = { id: "bot", threadId: "chat", modelSelection: { instanceId: "grok", model: "grok-code-fast-1" } } as BotRecord;
  const turn = { threadId: bot.threadId, model: bot.modelSelection.model, depth: 0 } as PrepareTurn;
  const prepare = vi.fn(async (_turn?: PrepareTurn) => {});
  const instance = { instanceId: "grok", driverKind: "grokAgent", prepare } as unknown as ProviderInstance;
  const state = { bot: bot as BotRecord | undefined, instance: instance as ProviderInstance | null, busy: false, smaller: false };
  const prewarmTurn = vi.fn(async () => turn as PrepareTurn | null);
  const claims = new Map<string, string | undefined>();
  const routes = createBotChatRoutes({
    store: { bot: () => state.bot }, instanceForBot: () => state.instance,
    botHasActiveTurn: () => state.busy, turnStartClaims: claims, prewarmTurn, smallerPc: () => state.smaller,
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  const focus = async () => {
    let status = 0;
    let data: unknown;
    const res = { writeHead: (code: number) => { status = code; }, end: (raw: string) => { data = JSON.parse(raw); } } as ServerResponse;
    await routes.prewarm(res, ["", bot.id] as RegExpMatchArray);
    await Promise.resolve();
    await Promise.resolve();
    return { status, data };
  };
  return { bot, turn, prepare, instance, state, claims, prewarmTurn, focus };
}

it("createBotChatRoutes prewarm passes the bot's turn to prepare after today's call", async () => {
  const h = harness();
  expect(await h.focus()).toEqual({ status: 200, data: { ok: true, prepared: true } });
  expect(h.prepare.mock.calls).toEqual([[], [h.turn]]);
  expect(h.prewarmTurn).toHaveBeenCalledWith(h.bot, h.instance);
});

function hold<T>() {
  let release!: (value: T) => void;
  const pending = new Promise<T>((resolve) => { release = resolve; });
  return { pending, release };
}

it.each(["claudeAgent", "codex", "antigravity", "grokAgent", "museAgent", "boxAgent"])("today's prepare runs first, once and unchanged for %s", async (kind) => {
  for (const smaller of [false, true]) {
    const h = harness();
    Object.assign(h.instance, { driverKind: kind });
    h.state.smaller = smaller;
    h.prewarmTurn.mockResolvedValue(null);
    h.prepare.mockImplementation(async () => { expect(h.prewarmTurn).not.toHaveBeenCalled(); });
    await h.focus();
    expect(h.prepare.mock.calls).toEqual([[]]);
    expect(h.prewarmTurn).toHaveBeenCalledTimes(smaller ? 0 : 1);
  }
});

it("the guess waits for today's prepare and answers before prepare finishes", async () => {
  const h = harness();
  const today = hold<void>();
  h.prepare.mockImplementationOnce(() => today.pending);
  expect(await h.focus()).toEqual({ status: 200, data: { ok: true, prepared: true } });
  expect(h.prepare.mock.calls).toEqual([[]]);
  expect(h.prewarmTurn).not.toHaveBeenCalled();
  today.release();
  await vi.waitFor(() => expect(h.prepare.mock.calls).toEqual([[], [h.turn]]));
});

it("a failed today's prepare adds nothing", async () => {
  const h = harness();
  h.prepare.mockRejectedValueOnce(new Error("unavailable"));
  await h.focus();
  expect(h.prepare.mock.calls).toEqual([[]]);
  expect(h.prewarmTurn).not.toHaveBeenCalled();
});

it("a null turn adds nothing", async () => {
  const h = harness();
  h.prewarmTurn.mockResolvedValue(null);
  await h.focus();
  expect(h.prepare.mock.calls).toEqual([[]]);
});

it.each(["busy", "claim", "smaller"])("skips a %s thread", async (reason) => {
  const h = harness();
  if (reason === "busy") h.state.busy = true;
  if (reason === "claim") h.claims.set(h.bot.id, h.bot.threadId);
  if (reason === "smaller") h.state.smaller = true;
  await h.focus();
  expect(h.prepare.mock.calls).toEqual([[]]);
  expect(h.prewarmTurn).not.toHaveBeenCalled();
});

it("one guess per bot and chat per 20 s; a new chat guesses at once", async () => {
  vi.useFakeTimers();
  const h = harness();
  await h.focus();
  await h.focus();
  vi.advanceTimersByTime(19_999);
  await h.focus();
  expect(h.prewarmTurn).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  await h.focus();
  expect(h.prewarmTurn).toHaveBeenCalledTimes(2);
  h.bot.threadId = "new-chat";
  await h.focus();
  expect(h.prewarmTurn).toHaveBeenCalledTimes(3);
  expect(h.prepare.mock.calls.filter((args) => !args.length)).toHaveLength(5);
});

it.each(["today", "lookup"])("declines changes during %s", async (stage) => {
  for (const change of ["busy", "claim", "bot", "chat", "model", "instance"] as const) {
    const h = harness();
    const today = hold<void>();
    const lookup = hold<PrepareTurn | null>();
    if (stage === "today") h.prepare.mockImplementationOnce(() => today.pending);
    else h.prewarmTurn.mockImplementationOnce(() => lookup.pending);
    await h.focus();
    if (change === "busy") h.state.busy = true;
    if (change === "claim") h.claims.set(h.bot.id, h.bot.threadId);
    if (change === "bot") h.state.bot = undefined;
    if (change === "chat") h.bot.threadId = "other";
    if (change === "model") h.bot.modelSelection = { ...h.bot.modelSelection, model: "other" };
    if (change === "instance") h.state.instance = { ...h.instance };
    today.release();
    lookup.release(h.turn);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.prepare.mock.calls, change).toEqual([[]]);
    if (stage === "today") expect(h.prewarmTurn, change).not.toHaveBeenCalled();
  }
});

it("a driver with no prepare keeps its answer", async () => {
  const h = harness();
  h.instance.prepare = undefined;
  expect(await h.focus()).toEqual({ status: 200, data: { ok: true, prepared: false, reason: "driver has no prepare" } });
  expect(h.prewarmTurn).not.toHaveBeenCalled();
});

it("app start without capture keeps today's call only", async () => {
  const h = harness();
  h.prewarmTurn.mockImplementation(async () => h.instance.cachedCapture?.() ? h.turn : null);
  await h.focus();
  expect(h.prepare.mock.calls).toEqual([[]]);
});

it("two tabs and a phone get one lease", async () => {
  const h = harness();
  const pool = createWarmPool({ totalmem: () => 32 * 1024 ** 3, freemem: () => 16 * 1024 ** 3, cpus: () => 16 });
  const captured = { incarnation: "grok#1", identity: "fake", generation: 0 };
  const made = vi.fn();
  h.prepare.mockImplementation(async (turn) => {
    const lease = pool.reserve({ engine: "grokAgent", instanceId: "grok", threadId: turn?.threadId ?? "__prewarm__" }, "fp", captured,
      turn ? "speculative" : "handshake", { focus: !!turn });
    if (typeof lease !== "object" || made.mock.calls.some(([prior]) => prior === lease)) return;
    made(lease);
    lease.attach({ session: { kind: "fresh" }, alive: () => true, close: async () => {} });
    lease.ready();
  });
  try {
    await Promise.all([h.focus(), h.focus(), h.focus()]);
    expect(h.prewarmTurn).toHaveBeenCalledTimes(1);
    expect(made).toHaveBeenCalledTimes(2);
    expect(pool.stats().idle).toBe(2);
  } finally {
    await pool.closeAll("test complete", { final: true });
  }
});
