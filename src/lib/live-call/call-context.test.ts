import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";

import { createLiveCallRoutes } from "../../../server/live-call.ts";
import { Store } from "../../../server/store.ts";
import { mergeTaskAsks } from "../../../server/task-asks.ts";
import { seedTaskResumePacket } from "../../../server/task-state-fold.ts";
import { LiveCall, type Posted } from "./controller";
import type { LiveEngine, LiveEvents } from "./engine";
import { route } from "./gemini";

it("answers a stub call from the live task record and sends unknown readiness to chat", async () => {
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = store.createBot({ name: "Juno" }, { seedMessages: false });
  const instruction = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Track release work" });
  const now = instruction.at;
  const packet = seedTaskResumePacket({ botId: bot.id, threadId: bot.threadId, text: instruction.text!, messageId: instruction.id, now, turnsAtWrite: 0 });
  const asks = mergeTaskAsks(packet, [
    { status: "waiting-for-user", ask: "Choose the billing plan" },
    { status: "waiting-for-user", ask: "Decide whether to move Dot" },
    { status: "building", ask: "Terminal pane fix" },
    { status: "building", ask: "Ctrl+F fix" },
  ], now);
  if ("error" in asks) throw new Error(asks.error);
  expect(store.writeTaskPacket({ ...packet, asks: asks.asks, lastAskId: asks.lastAskId })).toBeTruthy();

  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ name: "auth_tokens/stub" }));
  const serve = createLiveCallRoutes({ cfg: { gemini: { apiKey: "stub" } }, store, dataDir: join(homedir(), "call"), taskPacket: (threadId) => store.taskPacket(threadId), fetch });
  const chat = vi.fn(async (_body: object): Promise<Posted> => ({ status: 202, data: { ok: true } }));
  async function post(path: string, body: object): Promise<Posted> {
    if (path.endsWith("/messages")) return chat(body);
    if (path.endsWith("/call/end")) return { status: 200, data: { ok: true } };
    const match = /\/([^/]+)\/call\/([^/]+)$/.exec(path);
    if (!match) throw new Error(`Unexpected path ${path}`);
    const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
    let status = 0;
    let raw = "";
    const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (body: string) => { raw = body; } } as unknown as ServerResponse;
    await serve(req, res, match);
    return { status, data: JSON.parse(raw) };
  }

  let events!: LiveEvents;
  const noop = () => {};
  const sendToolResult = vi.fn<LiveEngine["sendToolResult"]>();
  const engine: LiveEngine = {
    connect: (_session, callbacks) => { events = callbacks; },
    sendAudio: noop, audioPaused: noop, sendText: noop, sendContext: noop, sendToolResult, close: noop,
  };
  const call = new LiveCall({
    botId: bot.id, botName: bot.name, device: "desktop", post, engine: () => engine,
    audio: { capture: async () => {}, heal: async () => true, play: noop, endTurn: noop, tune: noop, stopMic: noop, flush: noop, close: noop, boop: noop, heardShare: () => 1, micLevel: () => 0, playing: false, onIdle: noop, onStart: noop },
  });
  const names = (record: string, status: string) => record.split("\n").filter((line) => line.startsWith(`- ${status}: `)).map((line) => String(JSON.parse(line.slice(line.indexOf(": ") + 2))));
  let turn = 0;
  async function askRecord(question: string): Promise<string> {
    const id = `task-${++turn}`;
    events.heard(question);
    route({ toolCall: { functionCalls: [{ id, name: "task_context" }] } }, events, { answering: false });
    return vi.waitFor(() => {
      expect(sendToolResult).toHaveBeenCalledWith([id], "task_context", expect.any(String));
      return String(sendToolResult.mock.lastCall![2]);
    });
  }
  function say(text: string) {
    events.answering();
    events.said(text);
    events.turnDone();
  }

  try {
    await call.start();
    events.ready();
    events.turnDone();
    const initial = await askRecord("What do I have to do today?");
    say(`${names(initial, "waiting-for-user").join(" and ")}.`);
    const readiness = await askRecord("Is the terminal pane fix ready?");
    expect(names(readiness, "building")).toEqual(["Terminal pane fix", "Ctrl+F fix"]);
    say(`The ${names(readiness, "building")[0]!.toLowerCase()} is still being built.`);

    const current = store.taskPacket(bot.threadId)!;
    const changed = mergeTaskAsks(current, [{ id: "A1", status: "done" }], now + 1);
    if ("error" in changed) throw new Error(changed.error);
    expect(store.writeTaskPacket({ ...current, asks: changed.asks })).toBeTruthy();
    const refreshed = await askRecord("What's left for me now?");
    say(`${names(refreshed, "waiting-for-user").join(" and ")}.`);

    const question = "Did the hamburger fix merge?";
    const unknown = await askRecord(question);
    expect(unknown).not.toContain("hamburger");
    events.toolCall([{ id: "check", name: "ask", args: { question } }]);
    await vi.waitFor(() => expect(sendToolResult).toHaveBeenCalledWith(["check"], "ask", "sent"));
    say("Let me check.");
    expect(chat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: question, call: { id: expect.any(String), ask: true } }));
    const transcript = await vi.waitFor(() => {
      const lines = store.activePath(bot.threadId).filter((row) => row.call).map((row) => `${row.call?.voice ? "Voice" : "Person"}: ${row.text}`);
      expect(lines).toEqual([
        "Person: What do I have to do today?",
        "Voice: Choose the billing plan and Decide whether to move Dot.",
        "Person: Is the terminal pane fix ready?",
        "Voice: The terminal pane fix is still being built.",
        "Person: What's left for me now?",
        "Voice: Decide whether to move Dot.",
        `Person: ${question}`,
        "Voice: Let me check.",
      ]);
      return lines;
    });
    console.log(["Stub engine transcript (fixture data, no microphone or speakers)", ...transcript, `Chat turn sent: ${question}`].join("\n"));
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    call.end();
  }
});
