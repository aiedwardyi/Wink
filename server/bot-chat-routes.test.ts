import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { Store } from "./store.ts";

describe("prewarm route", () => {
  it("prepares the bot's thread with its model, effort and approval", async () => {
    const prepare = vi.fn(async () => {});
    const bot = { id: "b1", threadId: "t1", autoApprove: false, modelSelection: { instanceId: "claude", mode: "pinned", model: "claude-opus-5-5", effort: "medium" } };
    const routes = createBotChatRoutes({ store: { bot: () => bot }, instanceForBot: () => ({ prepare }) } as never);
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;

    await routes.prewarm(res, ["", "b1"] as unknown as RegExpMatchArray);
    expect(prepare).toHaveBeenCalledWith(undefined, { threadId: "t1", model: "claude-opus-5-5", effort: "medium", approval: "ask" });
  });

  it("answers prepared:false with a reason for a driver it can't prewarm", async () => {
    const bot = { id: "b1", threadId: "t1", autoApprove: false, modelSelection: { instanceId: "codex", mode: "pinned", model: "gpt-5", effort: "medium" } };
    const firstTurnLaunch = vi.fn();
    const routes = createBotChatRoutes({ store: { bot: () => bot }, instanceForBot: () => ({}), firstTurnLaunch } as never);
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;

    await routes.prewarm(res, ["", "b1"] as unknown as RegExpMatchArray);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, prepared: false, reason: "driver has no prepare" }));
    expect(firstTurnLaunch).not.toHaveBeenCalled();
  });
});

describe("send to an unloaded chat", () => {
  const now = 1_800_000_000_000;
  const fresh = () => new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));

  afterEach(() => vi.restoreAllMocks());

  async function sentAt(store: Store, botId: string, actedAt: number) {
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(performance, "now").mockReturnValue(0);
    const startTurn = vi.fn(async (_botId: string, _text: string, _opts?: { actedAt?: number }) => ({}));
    const routes = createBotChatRoutes({
      store, cfg: {}, threadSyncGate: { enabled: false }, pullSyncedThread: () => {}, noteTalked: () => {}, resolveReplyTarget: () => undefined,
      sendSequencer: { run: (_key: unknown, _print: unknown, send: () => unknown) => send() }, instanceForBot: () => null, botHasActiveTurn: () => false,
      startTurn, ensureChatLatency: () => {}, markChatLatency: () => {}, drainQueuedSends: () => {},
    } as never);
    const req = Readable.from([JSON.stringify({ text: "hi", actedAt, sendId: "send-unloaded-0001" })]) as unknown as IncomingMessage;
    await routes.send(req, { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse, ["", botId] as unknown as RegExpMatchArray);
    vi.restoreAllMocks();
    return startTurn.mock.calls[0]![2]!.actedAt;
  }

  it("loads the chat off the server thread, and caps the send by the same clock", async () => {
    const writer = fresh();
    const bot = writer.createBot({ name: "Long" }, { seedMessages: false });
    for (let i = 0; i < 300; i++) writer.appendMessage(bot.threadId, { role: i % 3 ? "bot" : "user", kind: "text", text: `line ${i}`, at: now - 1_000_000 + i });
    writer.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "stamped ahead", at: now + 60_000 });
    writer.appendMessage(bot.threadId, { role: "user", kind: "text", text: "acted ahead", at: now - 10, actedAt: now + 70_000 });
    writer.appendMessage(bot.threadId, { role: "user", kind: "text", text: "waited", at: now - 5, actedAt: now + 90_000, waited: true });

    for (const actedAt of [now - 5, now + 80_000]) {
      const cold = fresh();
      const reads: boolean[] = [];
      // SAFETY: thread() is Store's whole read of a chat into its cache; the test only watches it.
      const whole = cold as unknown as { thread(threadId: string): unknown };
      const thread = whole.thread.bind(cold);
      whole.thread = (threadId) => { reads.push(cold.loaded(threadId)); return thread(threadId); };
      const stamped = await sentAt(cold, bot.id, actedAt);
      expect(reads.filter((loaded) => !loaded)).toEqual([]);
      expect(cold.loaded(bot.threadId)).toBe(true);
      expect(stamped).toBe(await sentAt(writer, bot.id, actedAt));
    }
    expect(await sentAt(fresh(), bot.id, now + 80_000)).toBe(now + 70_001);
  });

  it("stamps an empty chat by the clock alone", async () => {
    const writer = fresh();
    const bot = writer.createBot({ name: "Empty" }, { seedMessages: false });
    expect(await sentAt(fresh(), bot.id, now + 5)).toBe(now);
    expect(await sentAt(writer, bot.id, now + 5)).toBe(now);
  });
});
