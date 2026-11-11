import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./quick-ask.ts", async (original) => ({
  ...await original<typeof import("./quick-ask.ts")>(),
  routesQuick: vi.fn(() => true),
  answerQuick: vi.fn(async () => {}),
}));

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { cancelQuickAsks } from "./quick-ask.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { drainSteeredMessages, foldQueuedSends, queueMark, _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";

const CALL = { id: "c-0123456789ab" };
afterEach(() => { _resetSteerQueue(); });

type Steer = (threadId: string, prompt: string, taken: (ok: boolean) => void) => Promise<boolean>;

function harness(opts: { quick?: boolean; activeTurn?: boolean; steer?: Steer; drain?: () => void } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "opus", effort: "max" as const }));
  const bot = store.createBot({}, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "earlier" });
  const steer = vi.fn<Steer>(opts.steer ?? (async () => true));
  const startTurn = vi.fn(async () => ({}));
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store, registry: new Map([["claude", { adapter: { capabilities: { queueing: true }, steer, interruptTurn: async () => {} } }]]),
    wireBot: () => ({}), wireTask: () => ({}), sendSequencer: new SendSequencer(), startTurn, noteTalked: noop, pullSyncedThread: noop,
    resolveReplyTarget: () => undefined, ensureChatLatency: noop, markChatLatency: noop, broadcast: noop, clearUnattended: noop, resumePaneWakes: noop,
    botHasActiveTurn: () => Boolean(opts.activeTurn || store.bot(bot.id)?.busy), paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: opts.drain ?? noop,
    routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop }, closeOpenApprovals: noop,
    ...(opts.quick ? { quick: { ask: {}, accountReady: () => true } } : {}),
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  async function send(body: object) {
    let status = 0;
    let data: Record<string, any> = {};
    const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
    await routes.send(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", bot.id] as RegExpMatchArray);
    return { status, data };
  }
  const last = () => store.activePath(bot.threadId).at(-1)!;
  return { store, bot, steer, startTurn, send, last, busy: () => store.setActivity(bot.id, "working") };
}

it("an idle order starts a turn with the call tag and the same text", async () => {
  const h = harness();
  await h.send({ text: "fix the login page", call: { ...CALL, order: true } });
  await h.send({ text: "fix the login page" });
  expect(h.startTurn.mock.calls[0]).toEqual([h.bot.id, "fix the login page", { threadId: h.bot.threadId, replyTo: undefined, sendId: undefined, call: { ...CALL, order: true } }]);
  expect(h.startTurn.mock.calls[1]).toEqual([h.bot.id, "fix the login page", { threadId: h.bot.threadId, replyTo: undefined, sendId: undefined, call: undefined }]);
});

it("a steered order keeps the tag; the steer prompt is byte-identical", async () => {
  const h = harness();
  h.busy();
  expect((await h.send({ text: "also run the tests", call: { ...CALL, order: true } })).data.steered).toBe(true);
  expect(h.last().call).toEqual({ ...CALL, order: true });
  await h.send({ text: "also run the tests" });
  expect(JSON.stringify(h.last())).not.toContain("\"call\"");
  const prompts = h.steer.mock.calls.map((call) => (call as unknown[])[1]);
  expect(prompts[0]).toBe(prompts[1]);
});

it("a queued order keeps the tag through drain and fold", async () => {
  const h = harness();
  h.busy();
  expect((await h.send({ text: "then deploy", deliver: "after", call: { ...CALL, order: true } })).data.queued).toBe(true);
  h.store.setActivity(h.bot.id, "idle");
  const run = vi.fn();
  drainSteeredMessages(h.store, run);
  expect(h.last()).toMatchObject({ text: "then deploy", call: { ...CALL, order: true } });
  expect(run).toHaveBeenCalledWith(h.bot.id, h.bot.threadId, "then deploy", expect.objectContaining({ call: { ...CALL, order: true } }), [h.last().id]);
});

it("a held send while the thread is still releasing keeps the tag, folded into the next turn", async () => {
  const h = harness({ activeTurn: true });
  const mark = queueMark();
  expect((await h.send({ text: "go", call: { ...CALL, order: true } })).data.queued).toBe(true);
  expect(foldQueuedSends(h.store, h.bot.id, h.bot.threadId, mark)).toEqual(["go"]);
  expect(h.last()).toMatchObject({ text: "go", steered: true, call: { ...CALL, order: true } });
});

it("orders skip Quick answers; asks and plain sends take them", async () => {
  const h = harness({ quick: true });
  h.busy();
  expect((await h.send({ text: "fix it", call: { ...CALL, order: true } })).data.quick).toBeUndefined();
  expect(h.last()).toMatchObject({ steered: true, call: { ...CALL, order: true } });
  expect(h.last().quick).toBeUndefined();
  expect((await h.send({ text: "what are you doing?", call: { ...CALL, ask: true } })).data.quick).toBe(true);
  expect(h.last()).toMatchObject({ quick: { state: "asked" }, call: { ...CALL, ask: true } });
  expect((await h.send({ text: "how far along?" })).data.quick).toBe(true);
});

it("a steered call send carries the call lines since the last user turn", async () => {
  const h = harness();
  h.store.appendMessage(h.bot.threadId, { role: "user", kind: "text", text: "Can you check the build?", call: CALL });
  h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "text", text: "Let me check.", call: { ...CALL, voice: true } });
  h.busy();
  await h.send({ text: "Check the build.", call: { ...CALL, ask: true } });
  await h.send({ text: "plain" });
  const [spoken, plain] = h.steer.mock.calls.map((call) => call[1]);
  expect(spoken).toContain("Person: Can you check the build?\nYou: Let me check.");
  expect(spoken!.endsWith("Check the build.")).toBe(true);
  expect(plain).not.toContain("Person:");
});

it("a call steer the engine dropped before the receipt goes down the queue", async () => {
  const h = harness({ steer: async (_threadId, _prompt, taken) => { taken(false); return true; } });
  h.busy();
  const { data } = await h.send({ text: "check the build", call: { ...CALL, order: true } });
  expect(data.queued).toBe(true);
  expect(h.last().text).toBe("earlier");
});

it("a call steer dropped after it was recorded goes down the queue once, on its own row", async () => {
  let taken!: (ok: boolean) => void;
  const drain = vi.fn();
  const h = harness({ steer: async (_threadId, _prompt, cb) => { taken = cb; return true; }, drain });
  h.busy();
  expect((await h.send({ text: "check the build", sendId: "send-call-0000000001", call: { ...CALL, order: true } })).data.steered).toBe(true);
  taken(false);
  taken(false);
  expect(drain).toHaveBeenCalledTimes(1);
  expect(h.last()).toMatchObject({ text: "check the build", call: { ...CALL, order: true } });
  expect(h.last().steered).toBeUndefined();
  h.store.setActivity(h.bot.id, "idle");
  const run = vi.fn();
  drainSteeredMessages(h.store, run);
  expect(run).toHaveBeenCalledTimes(1);
  expect(h.store.activePath(h.bot.threadId).filter((row) => row.text === "check the build")).toHaveLength(1);
});

it("a call steer dropped after Stop stays stopped", async () => {
  let taken!: (ok: boolean) => void;
  const drain = vi.fn();
  const h = harness({ steer: async (_threadId, _prompt, cb) => { taken = cb; return true; }, drain });
  h.busy();
  await h.send({ text: "check the build", call: { ...CALL, order: true } });
  cancelQuickAsks(h.store, h.bot.id, [h.bot.threadId]);
  taken(false);
  expect(drain).not.toHaveBeenCalled();
  expect(h.last().steered).toBe(true);
});

it("a call steer taken as the turn ended is recorded, not refused", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({ steer: async () => { h.store.setActivity(h.bot.id, "idle"); return true; } });
  h.busy();
  const { status, data } = await h.send({ text: "check the build", call: { ...CALL, order: true } });
  expect(status).toBe(202);
  expect(data.steered).toBe(true);
  expect(h.last()).toMatchObject({ text: "check the build", steered: true });
});
