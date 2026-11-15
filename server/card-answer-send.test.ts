import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { lineSettles } from "../shared/open-question.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { planCompaction } from "./context-compaction.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { drainSteeredMessages, foldQueuedSends, queueMark, _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";

afterEach(() => { _resetSteerQueue(); });

function harness(opts: { activeTurn?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "opus", effort: "max" as const }));
  const bot = store.createBot({}, { seedMessages: false });
  const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Dinner?", options: ["Can't tonight", "Sure"], askUser: true, staysOpen: true } });
  const steer = vi.fn(async () => true);
  const startTurn = vi.fn(async (..._args: unknown[]) => ({}));
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store, registry: new Map([["claude", { adapter: { capabilities: { queueing: true }, steer, interruptTurn: async () => {} } }]]),
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
  await h.send({ text: "Can't tonight", cardId: "not-a-card" });
  expect(h.startTurn.mock.calls[0]).toEqual([h.bot.id, "Can't tonight", expect.objectContaining({ answersCard: h.card.id })]);
  expect(h.startTurn.mock.calls[1]![2]).not.toHaveProperty("answersCard", expect.anything());
});

it("a tap marks only a card on the active path", async () => {
  const h = harness();
  h.store.branchMessage(h.bot.threadId, h.card.id, "start over");
  await h.send({ text: "Can't tonight", cardId: h.card.id });
  expect(h.startTurn.mock.calls[0]![2]).not.toHaveProperty("answersCard", expect.anything());
});

it("a tap into a running turn steers the same prompt and marks the row", async () => {
  const h = harness();
  h.busy();
  expect((await h.send({ text: "Can't tonight", cardId: h.card.id })).steered).toBe(true);
  expect(h.last()).toMatchObject({ role: "user", kind: "text", text: "Can't tonight", steered: true, answersCard: h.card.id });
  await h.send({ text: "Can't tonight" });
  expect(h.last().answersCard).toBeUndefined();
  const prompts = h.steer.mock.calls.map((call) => (call as unknown[])[1]);
  expect(prompts[0]).toBe(prompts[1]);
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
  expect(foldQueuedSends(held.store, held.bot.id, held.bot.threadId, mark)).toEqual(["Sure"]);
  expect(held.last()).toMatchObject({ text: "Sure", steered: true, answersCard: held.card.id });
});

it("the model still reads a tapped answer on replay", async () => {
  const h = harness();
  h.busy();
  await h.send({ text: "Can't tonight", cardId: h.card.id });
  const plan = planCompaction({ messages: h.store.activePath(h.bot.threadId), contextWindow: 1_000_000 });
  if (plan.needed || plan.status !== "fits") throw new Error("expected the whole transcript");
  expect(plan.transcript).toContainEqual(expect.objectContaining({ role: "user", text: expect.stringContaining("Can't tonight") }));
});

it.each([
  { name: "without choices", card: { options: [], staysOpen: true as const } },
  { name: "with choices that stays open", card: { options: ["Can't tonight", "Sure"], staysOpen: true as const } },
  { name: "with choices that closes", card: { options: ["Can't tonight", "Sure"] } },
])("the client saves a typed answer only when its line leaves a question $name open", async ({ card }) => {
  const h = harness();
  const asked = h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Which star?", askUser: true, ...card } });
  const byLine = lineSettles(h.store.activePath(h.bot.threadId), asked, "Polaris");
  h.busy();
  expect((await h.send({ text: "Polaris" })).steered).toBe(true);
  expect(await h.patchCard(asked.id, { answered: "Polaris" })).toBe(byLine ? 409 : 200);
});
