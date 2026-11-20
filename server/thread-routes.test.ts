import { rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BotTrash } from "./bot-trash.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { RoutineManager } from "./routines.ts";
import { Store } from "./store.ts";
import { createThreadRoutes } from "./thread-routes.ts";

function pager() {
  vi.useFakeTimers();
  const messagePage = vi.fn(() => ({ messages: [], hasMore: true }));
  const route = createThreadRoutes({
    dataDir: DATA_DIR, store: { botByThread: () => ({}), messagesFor: () => [{ id: "cursor" }] },
    threadSyncGate: { enabled: false }, pullSyncedThread: vi.fn(), DEFAULT_PAGE: 50,
    pageSize: (raw: string | null) => raw === null ? undefined : Math.min(Number(raw), 200), messagePage, messageWindow: vi.fn(() => ({ messages: [], hasMore: false })),
  } as unknown as Parameters<typeof createThreadRoutes>[0]);
  let body = "";
  const request = async (query: string) => {
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } } as unknown as ServerResponse;
    await route.listMessages(res, ["", "thread"] as RegExpMatchArray, new URL(`http://localhost/messages?${query}`));
    return status;
  };
  return { request, messagePage, error: () => JSON.parse(body).error as string };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("older message batches", () => {
  it("returns five bounded pages in one request", async () => {
    const { request, messagePage } = pager();
    expect(await request("limit=200&before=cursor&pages=5")).toBe(200);
    expect(messagePage).toHaveBeenCalledExactlyOnceWith("thread", 1000, "cursor");
  });

  it("keeps ordinary pages bounded", async () => {
    const { request, messagePage } = pager();
    expect(await request("limit=1000&before=cursor")).toBe(200);
    expect(messagePage).toHaveBeenCalledExactlyOnceWith("thread", 200, "cursor");
  });

  it.each(["pages=0&before=cursor", "pages=6&before=cursor", "pages=1.5&before=cursor", "pages=no&before=cursor", "pages=5", "around=cursor&pages=5"])("rejects an invalid batch: %s", async (query) => {
    const { request, messagePage } = pager();
    expect(await request(query)).toBe(400);
    expect(messagePage).not.toHaveBeenCalled();
  });

  it.each(["before=cursor&around=cursor", "before=cursor&around=cursor&pages=5", "before=cursor&around=cursor&pages=9"])("names the before and around clash first: %s", async (query) => {
    const { request, error } = pager();
    expect(await request(query)).toBe(400);
    expect(error()).toBe("before and around cannot be combined");
  });
});

describe("search", () => {
  it("returns live hits past a trashed bot's", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const routines = new RoutineManager({
      file: join(DATA_DIR, "routines.json"),
      botState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
      startChatTurn: async () => {},
    });
    const live = store.createBot({ name: "Live" }, { seedMessages: false });
    const trashed = store.createBot({ name: "Trashed" }, { seedMessages: false });
    for (let i = 0; i < 3; i++) store.appendMessage(live.threadId, { role: "user", kind: "text", text: `kiwi live ${i}`, at: 1_000 + i });
    for (let i = 0; i < 50; i++) store.appendMessage(trashed.threadId, { role: "user", kind: "text", text: `kiwi trashed ${i}`, at: 2_000 + i });
    new BotTrash(store, routines).trash(trashed.id);
    const route = createThreadRoutes({ dataDir: DATA_DIR, store, clientMessage: (message: unknown) => message } as unknown as Parameters<typeof createThreadRoutes>[0]);
    let body = "";
    const res = { writeHead: () => {}, end: (text: string) => { body = text; } } as unknown as ServerResponse;

    await route.search(res, new URL("http://localhost/search?q=kiwi"));

    expect(JSON.parse(body).hits.map((hit: { botId: string }) => hit.botId)).toEqual([live.id, live.id, live.id]);
  });

  it("leaves out the threads it is told to hide", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({ name: "Live" }, { seedMessages: false });
    const room = store.createGroup("Team", [bot.id], false, undefined, undefined, { roomId: "r1" });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "kiwi here", at: 1_000 });
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: "kiwi in the room", at: 2_000 });
    const route = createThreadRoutes({ dataDir: DATA_DIR, store, clientMessage: (message: unknown) => message } as unknown as Parameters<typeof createThreadRoutes>[0]);
    let body = "";
    const res = { writeHead: () => {}, end: (text: string) => { body = text; } } as unknown as ServerResponse;

    await route.search(res, new URL("http://localhost/search?q=kiwi"), [room.threadId]);

    expect(JSON.parse(body).hits.map((hit: { threadId: string }) => hit.threadId)).toEqual([bot.threadId]);
  });
});

describe("find in a chat not in memory", () => {
  it("answers without loading the chat, and still marks the version an edit replaced", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
    const writer = new Store(selection);
    const bot = writer.createBot({ name: "Long" }, { seedMessages: false });
    const first = writer.appendMessage(bot.threadId, { role: "user", kind: "text", text: "kiwi first", at: 1_000 });
    writer.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "kiwi reply", at: 1_001 });
    writer.branchMessage(bot.threadId, first.id, "kiwi edited");
    for (let i = 0; i < 300; i++) writer.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `row ${i}` });
    writer.appendMessage(bot.threadId, { role: "user", kind: "text", text: "kiwi newest" });
    closeMessageDb();
    const store = new Store(selection);
    const route = createThreadRoutes({ dataDir: DATA_DIR, store, clientMessage: (message: unknown) => message } as unknown as Parameters<typeof createThreadRoutes>[0]);
    const find = async (q = "kiwi") => {
      let body = "";
      const res = { writeHead: () => {}, end: (text: string) => { body = text; } } as unknown as ServerResponse;
      await route.search(res, new URL(`http://localhost/search?q=${q}&threadId=${bot.threadId}&view=chips`));
      return Object.fromEntries(JSON.parse(body).hits.map((hit: { snippet: string; onActivePath: boolean }) => [hit.snippet, hit.onActivePath]));
    };
    const shown = { "kiwi newest": true, "kiwi edited": true, "kiwi reply": false, "kiwi first": false };

    expect(await find("plum")).toEqual({});
    expect(await find()).toEqual(shown);
    // the old route read and parsed every row of the chat to answer this
    expect(store.loaded(bot.threadId)).toBe(false);
    store.messagesFor(bot.threadId);
    expect(await find()).toEqual(shown);
  });
});

describe("media", () => {
  it("lists a chat's files in one answer, then the version alone, and 404s an unknown chat", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({ name: "Live" }, { seedMessages: false });
    const sent = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "[a.png](C:\\w\\a.png)", at: 1_000 });
    const route = createThreadRoutes({ dataDir: DATA_DIR, store, threadSyncGate: { enabled: false }, pullSyncedThread: vi.fn() } as unknown as Parameters<typeof createThreadRoutes>[0]);
    const get = async (threadId: string, query = "") => {
      let status = 0;
      let body = "";
      const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } } as unknown as ServerResponse;
      await route.media(res, ["", threadId] as RegExpMatchArray, new URL(`http://localhost/media${query}`));
      return { status, body: JSON.parse(body) };
    };

    expect((await get("nope")).status).toBe(404);
    const first = await get(bot.threadId);
    expect(first).toMatchObject({ status: 200, body: { ids: [sent.id], kind: "l", name: ["a.png"], ref: ["C:\\w\\a.png"] } });
    expect(await get(bot.threadId, `?v=${first.body.v}`)).toEqual({ status: 200, body: { v: first.body.v } });
  });
});
