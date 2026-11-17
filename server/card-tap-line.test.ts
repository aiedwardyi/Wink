import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { isShownMessage } from "../src/lib/shown-message.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";

afterEach(() => { _resetSteerQueue(); });

function harness() {
  const store = new Store(() => ({ instanceId: "claude", model: "opus", effort: "max" as const }));
  const bot = store.createBot({}, { seedMessages: false });
  const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Dinner?", options: ["Can't tonight", "Sure"], askUser: true } });
  const startTurn = vi.fn(async (..._args: unknown[]) => ({}));
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store, registry: new Map([["claude", { adapter: { capabilities: { queueing: true }, steer: async () => true, interruptTurn: async () => {} } }]]),
    wireBot: () => ({}), wireTask: () => ({}), sendSequencer: new SendSequencer(), startTurn, noteTalked: noop, pullSyncedThread: noop,
    resolveReplyTarget: () => undefined, ensureChatLatency: noop, markChatLatency: noop, broadcast: noop, clearUnattended: noop, resumePaneWakes: noop,
    botHasActiveTurn: () => Boolean(store.bot(bot.id)?.busy), paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: noop,
    routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop }, closeOpenApprovals: noop, clientMessage: (message: unknown) => message,
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  const send = async (body: object) => {
    const res = { writeHead: noop, setHeader: noop, end: noop } as unknown as ServerResponse;
    await routes.send(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", bot.id] as RegExpMatchArray);
  };
  return { store, bot, card, startTurn, send };
}

it("a tapped choice is the person's own shown line, idle or into a running turn", async () => {
  const idle = harness();
  await idle.send({ text: "Sure", cardId: idle.card.id });
  expect(idle.startTurn.mock.calls[0]!.slice(0, 2)).toEqual([idle.bot.id, "Sure"]);

  const busy = harness();
  busy.store.setActivity(busy.bot.id, "working");
  await busy.send({ text: "Sure", cardId: busy.card.id });
  const line = busy.store.activePath(busy.bot.threadId).at(-1)!;
  expect(line).toMatchObject({ role: "user", kind: "text", text: "Sure" });
  expect(isShownMessage(line)).toBe(true);
});
