import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { planCompaction } from "./context-compaction.ts";
import type { ProviderInstance } from "./contracts.ts";
import { composeUserTurnPrompt } from "./replies.ts";
import { requeueDroppedCall } from "./quick-ask.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { drainSteeredMessages, foldQueuedSends, queueMark, _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";

afterEach(() => { _resetSteerQueue(); });

function harness(opts: { activeTurn?: boolean; steerConsumed?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "opus", effort: "max" as const }));
  const bot = store.createBot({}, { seedMessages: false });
  const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Dinner?", options: ["Can't tonight", "Sure"], askUser: true, staysOpen: true } });
  const steer = vi.fn<NonNullable<ProviderInstance["adapter"]["steer"]>>(async () => true);
  const startTurn = vi.fn<Parameters<typeof createBotChatRoutes>[0]["startTurn"]>(async () => ({}));
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store, registry: new Map([["claude", { adapter: { capabilities: { queueing: true, steerConsumed: opts.steerConsumed }, steer, interruptTurn: async () => {} } }]]),
    wireBot: () => ({}), wireTask: () => ({}), sendSequencer: new SendSequencer(), startTurn, noteTalked: noop, pullSyncedThread: noop,
    resolveReplyTarget: () => undefined, ensureChatLatency: noop, markChatLatency: noop, broadcast: noop, clearUnattended: noop, resumePaneWakes: noop,
    botHasActiveTurn: () => Boolean(opts.activeTurn || store.bot(bot.id)?.busy), paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: noop,
    routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop }, closeOpenApprovals: noop, clientMessage: (message: unknown) => message,
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  async function call(route: "send" | "patchCard", body: object, ...params: string[]) {
    let status = 0;
    let data: Record<string, any> = {};
    const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
    await routes[route](Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", bot.id, ...params] as RegExpMatchArray);
    return { status, data };
  }
  const send = async (body: object) => (await call("send", body)).data;
  const patchCard = async (cardId: string, body: object) => (await call("patchCard", body, cardId)).status;
  const last = () => store.activePath(bot.threadId).at(-1)!;
  return { store, bot, card, steer, startTurn, send, patchCard, last, busy: () => store.setActivity(bot.id, "working") };
}

it("an idle tap starts the same turn and marks the line with its card", async () => {
  const h = harness();
  await h.send({ text: "Can't tonight", cardId: h.card.id });
  await expect(h.send({ text: "Can't tonight", cardId: "not-a-card" })).rejects.toMatchObject({ status: 409 });
  expect(h.startTurn.mock.calls[0]).toEqual([h.bot.id, "Can't tonight", expect.objectContaining({ answersCard: h.card.id })]);
  expect(h.startTurn).toHaveBeenCalledTimes(1);
});

it("keeps the click time through idle, steering and queued delivery", async () => {
  const actedAt = Date.now() - 10_000;
  const idle = harness();
  await idle.send({ text: "Sure", cardId: idle.card.id, actedAt });
  expect(idle.startTurn.mock.calls[0]![2]).toMatchObject({ actedAt });
  const busy = harness();
  busy.busy();
  await busy.send({ text: "Sure", cardId: busy.card.id, actedAt });
  expect(busy.last()).toMatchObject({ actedAt });
  const queued = harness();
  queued.busy();
  await queued.send({ text: "Sure", cardId: queued.card.id, deliver: "after", actedAt });
  queued.store.setActivity(queued.bot.id, "idle");
  drainSteeredMessages(queued.store, vi.fn());
  expect(queued.last()).toMatchObject({ actedAt });
});

it("coalesces transport retries with the same send identity", async () => {
  const h = harness();
  h.busy();
  const body = { text: "Sure", cardId: h.card.id, sendId: crypto.randomUUID() };
  await Promise.all([h.send(body), h.send(body)]);
  expect(h.store.messagesFor(h.bot.threadId).filter((message) => message.answersCard === h.card.id)).toHaveLength(1);
  expect(h.steer).toHaveBeenCalledTimes(1);
});

it("accepts only one of two unique taps while the first steer is awaiting acceptance", async () => {
  const h = harness();
  h.busy();
  let entered!: () => void;
  let release!: (accepted: boolean) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<boolean>((resolve) => { release = resolve; });
  h.steer.mockImplementationOnce(() => { entered(); return held; });
  const first = h.send({ text: "Sure", cardId: h.card.id, sendId: crypto.randomUUID() });
  await started;
  const second = h.send({ text: "Can't tonight", cardId: h.card.id, sendId: crypto.randomUUID() });
  await new Promise<void>((resolve) => setImmediate(resolve));
  release(true);
  const results = await Promise.allSettled([first, second]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(h.steer).toHaveBeenCalledOnce();
  expect(h.store.messagesFor(h.bot.threadId).filter((message) => message.answersCard === h.card.id)).toHaveLength(1);
});

it.each([-1, "yesterday", null])("ignores an invalid client action time: %s", async (actedAt) => {
  const h = harness();
  await h.send({ text: "Sure", cardId: h.card.id, actedAt });
  expect(h.startTurn.mock.calls[0]![2]).toMatchObject({ actedAt: undefined });
});

it("a tap marks only a card on the active path", async () => {
  const h = harness();
  h.store.branchMessage(h.bot.threadId, h.card.id, "start over");
  await expect(h.send({ text: "Can't tonight", cardId: h.card.id })).rejects.toMatchObject({ status: 409 });
  expect(await h.patchCard(h.card.id, { answered: "Can't tonight" })).toBe(404);
  expect(h.startTurn).not.toHaveBeenCalled();
});

it.each([false, true])("a tap into a running turn carries its question only in the provider prompt (consumed: %s)", async (steerConsumed) => {
  const h = harness({ steerConsumed });
  h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "text", text: "Earlier plan", reactions: [{ emoji: "👎", by: "user" }] });
  h.busy();
  expect((await h.send({ text: "Can't tonight", cardId: h.card.id })).steered).toBe(true);
  expect(h.last()).toMatchObject({ role: "user", kind: "text", text: "Can't tonight", steered: true, answersCard: h.card.id });
  await h.send({ text: "Can't tonight" });
  expect(h.last().answersCard).toBeUndefined();
  const prompts = h.steer.mock.calls.map((call) => call[1]);
  expect(prompts[0]).toContain(h.card.id);
  expect(prompts[0]).toContain("Dinner?");
  expect(prompts[1]).not.toContain(h.card.id);
  expect(prompts[0].includes("reject/negative")).toBe(steerConsumed);
  if (!steerConsumed) expect(prompts[1]).toBe("Can't tonight");
});

it("a queued tap keeps its card through drain and fold", async () => {
  const h = harness();
  h.busy();
  expect((await h.send({ text: "Sure", deliver: "after", cardId: h.card.id })).queued).toBe(true);
  h.store.setActivity(h.bot.id, "idle");
  const run = vi.fn();
  drainSteeredMessages(h.store, run);
  expect(h.last()).toMatchObject({ text: "Sure", answersCard: h.card.id });
  expect(run).toHaveBeenCalledWith(h.bot.id, h.bot.threadId, "Sure", expect.objectContaining({ answersCard: h.card.id }), [h.last().id]);

  const held = harness({ activeTurn: true });
  const mark = queueMark();
  expect((await held.send({ text: "Sure", cardId: held.card.id })).queued).toBe(true);
  const folded = foldQueuedSends(held.store, held.bot.id, held.bot.threadId, mark);
  expect(folded).toEqual([expect.stringContaining(held.card.id)]);
  expect(folded[0]).toContain("Dinner?");
  expect(held.last()).toMatchObject({ text: "Sure", steered: true, answersCard: held.card.id });
});

it("the model still reads a tapped answer on replay", async () => {
  const h = harness();
  h.busy();
  await h.send({ text: "Can't tonight", cardId: h.card.id });
  const plan = planCompaction({ messages: h.store.activePath(h.bot.threadId), contextWindow: 1_000_000 });
  if (plan.needed || plan.status !== "fits") throw new Error("expected the whole transcript");
  const answer = plan.transcript.find((message) => message.role === "user")!;
  expect(answer.text).toContain("Can't tonight");
  expect(answer.text).toContain(h.card.id);
  expect(answer.text).toContain("Dinner?");
});

it.each([true, false])("Send now keeps the queued answer's question (busy: %s)", async (busy) => {
  const h = harness();
  h.busy();
  const sendId = "send-card-answer-001";
  const queued = await h.send({ text: "Sure", cardId: h.card.id, sendId, deliver: "after" });
  expect(queued.queued).toBe(true);
  if (!busy) h.store.setActivity(h.bot.id, "idle");
  await h.send({ text: "Sure", sendId, queueId: queued.queueId });
  if (busy) {
    expect(h.steer.mock.calls[0]![1]).toContain(h.card.id);
    expect(h.last()).toMatchObject({ text: "Sure", answersCard: h.card.id });
  } else {
    const [, text, opts] = h.startTurn.mock.calls[0]!;
    expect(opts?.answersCard).toBe(h.card.id);
    expect(composeUserTurnPrompt(text, { messages: h.store.activePath(h.bot.threadId), ...opts })).toContain("Dinner?");
  }
});

it("a call answer dropped by the engine keeps its question when folded into the next turn", () => {
  const h = harness();
  const answer = h.store.appendMessage(h.bot.threadId, {
    role: "user", kind: "text", text: "Sure", answersCard: h.card.id, steered: true, call: { id: "c-0123456789ab", ask: true },
  });
  const mark = queueMark();
  requeueDroppedCall(h.store, h.bot.id, h.bot.threadId, answer, () => {});
  const folded = foldQueuedSends(h.store, h.bot.id, h.bot.threadId, mark);
  expect(folded).toEqual([expect.stringContaining(h.card.id)]);
  expect(folded[0]).toContain("Dinner?");
  expect(h.last()).toMatchObject({ id: answer.id, text: "Sure", answersCard: h.card.id });
});

it("an unquoted tap or card-typed answer carries the exact question on an idle turn", async () => {
  const h = harness();
  const question = "When you type an answer to an open question card, should the sidekick also reply beside it? (my pick: yes)\n" + "Exact long question. ".repeat(20);
  h.store.patchMessage(h.bot.threadId, h.card.id, { card: { ...h.card.card!, subtitle: question } });
  for (const text of ["No, leave it", "Only when I ask in my own words"]) {
    await h.send({ text, cardId: h.card.id });
    const [botId, sent, opts] = h.startTurn.mock.calls.at(-1)!;
    expect(botId).toBe(h.bot.id);
    expect(sent).toBe(text);
    const prompt = composeUserTurnPrompt(sent, { messages: h.store.activePath(h.bot.threadId), ...opts });
    expect(prompt).toContain(h.card.id);
    expect(prompt).toContain(question);
    expect(prompt).toContain(text);
  }
});

it("ten same-label card answers interleaved with typed messages each name only their own question", async () => {
  const h = harness();
  const cards = Array.from({ length: 10 }, (_, i) => h.store.appendMessage(h.bot.threadId, {
    role: "bot", kind: "options", card: { title: "Q", subtitle: `Decision ${i}?`, options: ["Yes"], askUser: true, staysOpen: true },
  }));
  h.busy();
  for (const [i, card] of cards.entries()) {
    await h.send({ text: "Yes", cardId: card.id });
    await h.send({ text: `Typed message ${i}` });
  }
  const prompts = h.steer.mock.calls.map((call) => call[1]);
  for (const [i, card] of cards.entries()) {
    expect(prompts[2 * i]).toContain(card.id);
    expect(prompts[2 * i]).toContain(card.card!.subtitle);
    for (const other of cards) if (other !== card) expect(prompts[2 * i]).not.toContain(other.id);
    expect(prompts[2 * i + 1]).not.toContain(card.id);
    expect(h.store.activePath(h.bot.threadId).filter((row) => row.answersCard === card.id)).toEqual([
      expect.objectContaining({ text: "Yes" }),
    ]);
  }
});

it.each([
  { name: "without choices", card: { options: [], staysOpen: true as const }, text: "Polaris", settles: true },
  { name: "with choices that stays open", card: { options: ["Can't tonight", "Sure"], staysOpen: true as const }, text: "Polaris", settles: false },
  { name: "with choices that closes", card: { options: ["Can't tonight", "Sure"] }, text: "Polaris", settles: true },
  { name: "with choices that stays open, typed as a choice", card: { options: ["Can't tonight", "Sure"], staysOpen: true as const }, text: "Can't tonight", settles: true },
])("a typed line that settles a question $name takes no second answer", async ({ card, text, settles }) => {
  const h = harness();
  const asked = h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Which star?", askUser: true, ...card } });
  h.busy();
  expect((await h.send({ text })).steered).toBe(true);
  expect(await h.patchCard(asked.id, { answered: text })).toBe(settles ? 409 : 200);
  if (settles && card.options.length) await expect(h.send({ text, cardId: asked.id })).rejects.toMatchObject({ status: 409 });
  else if (!card.options.length) {
    await h.send({ text, cardId: asked.id });
    expect(h.last()).toMatchObject({ text, answersCard: undefined });
  }
});

it("still receives an answer saved by an older client's card PATCH", async () => {
  const h = harness();
  expect(await h.patchCard(h.card.id, { answered: "Sure" })).toBe(200);
  await h.send({ text: "Sure", cardId: h.card.id });
  expect(h.startTurn).toHaveBeenCalledOnce();
});
