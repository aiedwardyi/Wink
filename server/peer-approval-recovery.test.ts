import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { resetEarlyListenForTests, startEarlyListen } from "./early-listen.ts";
import { closeMessageDb, insertMessage, messageDatabase, setActiveLeaf } from "./message-db.ts";
import { cancelPeerApprovalsFor, dismissStalePeerCards, requestPeerApproval } from "./peer-approval.ts";
import { Store, type Message, type StoreChange } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "fake-model" });
const row = (id: string, card: Record<string, unknown> = {}): Message => ({
  id, at: 1, role: "bot", kind: "options",
  card: { title: "Peer approval", options: ["Allow", "Deny"], requestId: id, tool: "ask_bot", ...card } as Message["card"],
});

describe("peer approval boot recovery", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(selection);
  });

  afterEach(async () => {
    await resetEarlyListenForTests();
    for (const bot of store.bots) cancelPeerApprovalsFor(bot.id);
    vi.restoreAllMocks();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("does not hydrate any transcript when there are no open peer cards", () => {
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Older", false)!;
    insertMessage(bot.threadId, row("provider", { tool: "Bash" }));
    insertMessage(bot.threadId, row("answered", { answered: "deny" }));
    insertMessage(task.threadId, row("dismissed", { dismissed: true }));
    insertMessage(task.threadId, row("no-request", { requestId: "" }));
    store = new Store(selection);
    const hydrate = vi.spyOn(store, "messagesFor");

    expect(dismissStalePeerCards({ store, broadcast: vi.fn() })).toBe(0);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("requires an exact peer tool name without coercing legacy values", () => {
    const bot = store.createBot({}, { seedMessages: false });
    const tools = [undefined, null, false, 0, "", "ASK_BOT", "ask_bot ", ["ask_bot"], {}];
    for (const [index, tool] of tools.entries()) insertMessage(bot.threadId, row(`tool-${index}`, { tool }));
    store = new Store(selection);
    const hydrate = vi.spyOn(store, "messagesFor");

    expect(dismissStalePeerCards({ store, broadcast: vi.fn() })).toBe(0);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("loads only candidate bot threads and keeps bot, task and rowid order across branches", () => {
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Background", false)!;
    const quiet = store.createTask(bot.id, "Quiet", false)!;
    const other = store.createBot({}, { seedMessages: false });
    const room = store.createGroup("Room", [bot.id, other.id]);
    insertMessage(other.threadId, row("other-first-in-db"));
    insertMessage(task.threadId, row("background"));
    insertMessage(bot.threadId, { ...row("z-first", { tool: "delegate_bot" }), at: 90, role: "user", kind: "text", parentId: null });
    insertMessage(bot.threadId, { ...row("a-second"), at: 1, parentId: null });
    insertMessage(quiet.threadId, row("closed", { answered: "allow" }));
    insertMessage(room.threadId, row("room"));
    insertMessage("unknown-thread", row("unknown"));
    setActiveLeaf(bot.threadId, "a-second");
    store = new Store(selection);
    const changes: StoreChange[] = [];
    store.onChange((change) => changes.push(change));
    const hydrate = vi.spyOn(store, "messagesFor");
    const broadcast = vi.fn();
    const stamp = () => messageDatabase().prepare("SELECT COUNT(*) AS n, MIN(rowid) AS first, MAX(rowid) AS last FROM messages").get();
    const before = stamp();

    expect(dismissStalePeerCards({ store, broadcast })).toBe(4);
    expect(hydrate.mock.calls).toEqual([[other.threadId], [bot.threadId], [task.threadId]]);
    expect(changes.map((change) => change.type === "message.patch" ? [change.threadId, change.message.id, change.message.card?.answered, change.message.card?.dismissed] : change.type)).toEqual([
      [other.threadId, "other-first-in-db", "deny", true],
      [bot.threadId, "z-first", "deny", true],
      [bot.threadId, "a-second", "deny", true],
      [task.threadId, "background", "deny", true],
    ]);
    expect(broadcast).not.toHaveBeenCalled();
    expect(stamp()).toEqual(before);
    hydrate.mockClear();
    expect(dismissStalePeerCards({ store, broadcast })).toBe(0);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it.each(["requestId", "answered", "dismissed"])("preserves JavaScript truthiness for legacy %s values", (field) => {
    const values = [undefined, null, false, 0, "", true, 1, "0", "false", " ", [], {}];
    const expected: string[] = [];
    const threads: string[] = [];
    for (const [index, value] of values.entries()) {
      const bot = store.createBot({}, { seedMessages: false });
      const id = `${field}-${index}`;
      insertMessage(bot.threadId, row(id, { [field]: value }));
      if (field === "requestId" ? Boolean(value) : !value) {
        expected.push(id);
        threads.push(bot.threadId);
      }
    }
    store = new Store(selection);
    const changes: StoreChange[] = [];
    store.onChange((change) => changes.push(change));
    const hydrate = vi.spyOn(store, "messagesFor");

    expect(dismissStalePeerCards({ store, broadcast: vi.fn() })).toBe(expected.length);
    expect(changes.map((change) => change.type === "message.patch" && change.message.id)).toEqual(expected.reverse());
    expect(hydrate.mock.calls.map(([threadId]) => threadId)).toEqual(threads.reverse());
  });

  it("skips live approvals without hydrating their threads", async () => {
    const bot = store.createBot({}, { seedMessages: false });
    const target = store.createBot({}, { seedMessages: false });
    const verdict = requestPeerApproval({ store, broadcast: vi.fn() }, bot, target, "ping", "ask_bot");
    const hydrate = vi.spyOn(store, "messagesFor");

    expect(dismissStalePeerCards({ store, broadcast: vi.fn() })).toBe(0);
    expect(hydrate).not.toHaveBeenCalled();
    cancelPeerApprovalsFor(bot.id);
    await expect(verdict).resolves.toBe("deny");
  });

  it("recovers imported legacy cards before accepting a queued turn", () => {
    const bot = store.createBot({}, { seedMessages: false });
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify([row("legacy")]));
    store = new Store(selection);
    vi.spyOn(Server.prototype, "listen").mockReturnThis();
    const early = startEarlyListen({ port: 9475 });
    const request = new IncomingMessage(new Socket());
    request.method = "POST";
    request.url = `/api/bots/${bot.id}/messages`;
    early.server.emit("request", request, new ServerResponse(request));
    const dispatch = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      expect(store.messagesFor(bot.threadId)[0].card).toMatchObject({ answered: "deny", dismissed: true });
      res.end();
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(dismissStalePeerCards({ store, broadcast: vi.fn() })).toBe(1);
    early.setHandler(dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const recover = index.indexOf("const stale = dismissStalePeerCards(approvalBus)");
    expect(recover).toBeGreaterThan(-1);
    expect(recover).toBeLessThan(index.indexOf("early.setHandler(handleRequest)"));
    expect(recover).toBeLessThan(index.indexOf("createServer(SERVER_TIMEOUTS, handleRequest)"));
  });

  it("counts only successful patches", () => {
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, row("stale"));
    vi.spyOn(store, "patchMessage").mockReturnValue(null);

    expect(dismissStalePeerCards({ store, broadcast: vi.fn() })).toBe(0);
  });
});
