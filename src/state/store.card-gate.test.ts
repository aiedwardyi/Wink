// @vitest-environment happy-dom
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createBotChatRoutes } from "../../server/bot-chat-routes.ts";
import { SendSequencer } from "../../server/send-idempotency.ts";
import { _resetSteerQueue, waitingSends } from "../../server/steer-queue.ts";
import { Store } from "../../server/store.ts";
import { Composer } from "@/components/Composer";
import { StoreProvider, useStore, type Bot, type Message } from "./store";

class EventSourceStub {
  static current: EventSourceStub;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  constructor() { EventSourceStub.current = this; }
  close() {}
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); _resetSteerQueue(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function mount(busy: boolean) {
  const backend = new Store(() => ({ instanceId: "waits", model: "m" }));
  const bot = backend.createBot({}, { seedMessages: false });
  const question = backend.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Which region?", options: ["Seoul", "Tokyo"], askUser: true, staysOpen: true } });
  if (busy) backend.setActivity(bot.id, "working");
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store: backend, registry: new Map([["waits", { adapter: { capabilities: {}, interruptTurn: async () => {} } }]]),
    wireBot: () => ({}), wireTask: () => ({}), sendSequencer: new SendSequencer(),
    startTurn: async (_bot: string, text: string, opts: { sendId?: string; answersCard?: string; actedAt?: number }) => ({ message: backend.appendMessage(bot.threadId, { role: "user", kind: "text", text, sendId: opts.sendId, answersCard: opts.answersCard, actedAt: opts.actedAt }) }),
    noteTalked: noop, pullSyncedThread: noop, resolveReplyTarget: () => undefined, ensureChatLatency: noop, markChatLatency: noop, broadcast: noop, clearUnattended: noop, resumePaneWakes: noop,
    botHasActiveTurn: () => Boolean(backend.bot(bot.id)?.busy), paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: noop,
    routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop }, closeOpenApprovals: noop, clientMessage: (message: unknown) => message,
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  const posts: Array<{ body: Record<string, unknown>; status: number; response: Record<string, any> }> = [];
  vi.stubGlobal("EventSource", EventSourceStub);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/bots?messages=200") return Response.json({ bots: [{ ...backend.bot(bot.id), messages: backend.messagesFor(bot.threadId) }], groups: [], queued: waitingSends() });
    if (url === "/api/instances") return Response.json({ instances: [] });
    let status = 0;
    let response: Record<string, any> = {};
    const res = { writeHead: (value: number) => { status = value; }, setHeader: noop, end: (raw: string) => { response = JSON.parse(raw); } } as unknown as ServerResponse;
    if (init?.method === "POST" && url.endsWith("/messages")) {
      const body = JSON.parse(String(init.body));
      try { await routes.send(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", bot.id] as RegExpMatchArray); }
      catch (error) { status = (error as { status?: number }).status ?? 500; response = { error: (error as Error).message }; }
      posts.push({ body, status, response });
      return Response.json(response, { status });
    }
    const cancel = url.match(/\/queue\/([^/]+)$/);
    if (init?.method === "DELETE" && cancel) {
      await routes.deleteQueued(res, ["", bot.id, cancel[1]] as RegExpMatchArray);
      return Response.json(response, { status });
    }
    return Response.json({});
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let front!: ReturnType<typeof useStore>;
  function View() {
    front = useStore();
    const current = front.state.bots.find((value) => value.id === bot.id);
    return current ? createElement(Composer, { bot: current as Bot }) : null;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(View))));
  await act(async () => EventSourceStub.current.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "gate:1" }), lastEventId: "" }));
  const tap = (answer: string) => act(async () => front.dispatch({ type: "answerCard", botId: bot.id, messageId: question.id, answer }));
  const reload = async () => {
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(StoreProvider, null, createElement(View))));
    await act(async () => EventSourceStub.current.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "gate:2" }), lastEventId: "" }));
  };
  return { backend, bot, question, posts, tap, host, reload, front: () => front };
}

it("gate 1a: cancellation permits a fresh tap on the same card", async () => {
  const h = await mount(true);
  await h.tap("Seoul");
  const queued = h.posts[0]!.response;
  expect(queued.queued).toBe(true);
  await vi.waitFor(() => expect(h.host.querySelector("[data-pending-question]")).toBeNull());
  await act(async () => h.front().dispatch({ type: "cancelQueued", botId: h.bot.id, threadId: h.bot.threadId, queueId: queued.queueId }));
  await vi.waitFor(() => expect(h.host.querySelector("[data-pending-question]")).not.toBeNull());
  await h.tap("Seoul");
  expect(h.posts[1]!.response).toMatchObject({ queued: true });
  expect(h.posts[1]!.body.sendId).not.toBe(h.posts[0]!.body.sendId);
});

it("gate 1b: editing the answer fork permits another choice", async () => {
  const h = await mount(false);
  await h.tap("Seoul");
  const answer = h.backend.activePath(h.bot.threadId).at(-1)!;
  h.backend.branchMessage(h.bot.threadId, answer.id, "Different instructions");
  const fork = h.backend.activePath(h.bot.threadId).at(-1)!;
  await act(async () => {
    h.front().dispatch({ type: "messageAdded", threadId: h.bot.threadId, message: fork as Message });
    h.front().dispatch({ type: "threadActive", threadId: h.bot.threadId, activeLeafId: fork.id });
  });
  await h.tap("Tokyo");
  expect(h.posts[1]!.status).toBe(202);
  expect(h.backend.activePath(h.bot.threadId).at(-1)).toMatchObject({ text: "Tokyo", answersCard: h.question.id });
});

it("gate 1c: a queued answer closes the choices and blocks another tap", async () => {
  const h = await mount(true);
  await h.tap("Seoul");
  await h.tap("Tokyo");
  expect(h.posts).toHaveLength(1);
  await vi.waitFor(() => expect(h.host.querySelector("[data-pending-question]")).toBeNull());
  expect(waitingSends()[h.bot.threadId]).toHaveLength(1);
});

it("gate 3: another client cannot queue a second answer to a reserved card", async () => {
  const h = await mount(true);
  await h.tap("Seoul");
  const response = await fetch(`/api/bots/${h.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Tokyo", threadId: h.bot.threadId, cardId: h.question.id, sendId: crypto.randomUUID() }) });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe("question already settled");
  expect(waitingSends()[h.bot.threadId]).toHaveLength(1);
});

it("gate 3: a queued card stays closed after reload and reopens on cancellation", async () => {
  const h = await mount(true);
  await h.tap("Seoul");
  await h.reload();
  expect(h.front().state.pendingQueued[h.bot.threadId]).toHaveLength(1);
  await vi.waitFor(() => expect(h.host.querySelector("[data-pending-question]")).toBeNull());
  const [queued] = h.front().state.pendingQueued[h.bot.threadId]!;
  await act(async () => h.front().dispatch({ type: "cancelQueued", botId: h.bot.id, threadId: h.bot.threadId, queueId: queued!.queueId }));
  await vi.waitFor(() => expect(h.host.querySelector("[data-pending-question]")).not.toBeNull());
});
