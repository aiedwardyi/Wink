import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createGroupRoutes } from "./group-routes.ts";
import { createRoomThreads } from "./room-thread-sync.ts";
import { Store } from "./store.ts";
import { syncHold } from "./sync-hold.ts";

const OWN = "own-writer";

beforeEach(() => {
  rmSync(join(DATA_DIR, "groups.json"), { force: true });
  rmSync(join(DATA_DIR, "bots.json"), { force: true });
  syncHold.reset();
});

afterEach(() => {
  vi.useRealTimers();
  syncHold.reset();
});

describe("room sends and chat sync", () => {
  it("holds a room send while a peer head for its thread is still downloading", async () => {
    const store = new Store(() => ({ instanceId: "fake", model: "m" }));
    const atlas = store.createBot({ name: "Atlas" }, { seedMessages: false });
    const group = store.createGroup("Plans", [atlas.id]);
    const folder = join(DATA_DIR, "google-drive");
    const head = `threads-v2/room-${group.id}/${group.threadId}/peer-writer/head.json`;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    syncHold.feed(folder, new Map([[head, [{
      id: "head", name: "head.json", md5Checksum: "a".repeat(32), createdTime: "2026-10-25T00:00:00Z", modifiedTime: "2026-10-25T00:00:00Z", trashed: false,
    }]]]), { profileDeviceId: "local", writerId: OWN, memoryDeviceId: "a".repeat(12) });
    const startGroupTurn = vi.fn(() => ({ id: "message-1" }));
    const routes = createGroupRoutes({
      store, startGroupTurn, resolveReplyTarget: () => undefined, syncSettled: (threadId: string) => syncHold.settle(threadId),
      sendSequencer: { run: (_key: unknown, _print: unknown, work: () => unknown) => work() },
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const sent = routes.postMessage(Readable.from([JSON.stringify({ text: "hi" })]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(startGroupTurn).not.toHaveBeenCalled();
    syncHold.release(group.threadId);
    await vi.advanceTimersByTimeAsync(200);
    await sent;
    expect(startGroupTurn).toHaveBeenCalledWith(group.id, "hi", undefined, undefined);
    expect(res.writeHead.mock.calls[0][0]).toBe(202);
  });

  it("sends a room message at once when no peer head is pending", async () => {
    const store = new Store(() => ({ instanceId: "fake", model: "m" }));
    const group = store.createGroup("Plans", []);
    const startGroupTurn = vi.fn(() => ({ id: "message-1" }));
    const routes = createGroupRoutes({
      store, startGroupTurn, resolveReplyTarget: () => undefined, syncSettled: (threadId: string) => syncHold.settle(threadId),
      sendSequencer: { run: (_key: unknown, _print: unknown, work: () => unknown) => work() },
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.postMessage(Readable.from([JSON.stringify({ text: "hi" })]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    expect(startGroupTurn).toHaveBeenCalledTimes(1);
  });
});

describe("room chats from another PC", () => {
  it("tells the server when a peer's delete removes the active task", () => {
    const store = new Store(() => ({ instanceId: "fake", model: "m" }));
    const group = store.createGroup("Plans", []);
    const ideas = store.createGroupTask(group.id, "Ideas")!;
    const deleted = vi.fn();
    const rooms = createRoomThreads({ store, botMap: () => ({}), syncId: (botId) => botId, deleted });
    rooms.apply(group.id, ideas.threadId, [{ cursor: 1, kind: "delete", rowId: "", value: null, conflict: false }]);
    expect(store.group(group.id)!.threadId).toBe(group.threadId);
    expect(deleted).toHaveBeenCalledWith(group.id);
  });

  it("sends a task rename through chat sync", () => {
    const store = new Store(() => ({ instanceId: "fake", model: "m" }));
    const group = store.createGroup("Plans", []);
    const task = store.groupTaskByThread(group.id, group.threadId)!;
    const writes: unknown[] = [];
    store.setSyncWriter((threadId, mutations, write) => {
      writes.push([threadId, mutations]);
      write();
    });
    store.renameGroupTask(group.id, group.threadId, "Launch");
    expect(writes).toEqual([[group.threadId, [{ kind: "metadata", value: { title: "Launch", createdAt: task.createdAt } }]]]);
  });

  it("maps the bot on a routine request card", () => {
    const store = new Store(() => ({ instanceId: "fake", model: "m" }));
    const atlas = store.createBot({ name: "Atlas" }, { seedMessages: false });
    const rooms = createRoomThreads({ store, botMap: () => ({ [atlas.id]: "sync-atlas" }), syncId: () => "sync-atlas" });
    const card = { routineRequest: { version: 1, requestId: "r1", botId: atlas.id, threadId: "t1", createdAt: 1 } };
    const message = { id: "m1", role: "bot", kind: "text", text: "", createdAt: 1, card } as unknown as Parameters<typeof rooms.outgoing>[0];
    expect(rooms.outgoing(message).card?.routineRequest?.botId).toBe("sync-atlas");
    expect(rooms.incoming(rooms.outgoing(message)).card?.routineRequest?.botId).toBe(atlas.id);
  });
});
