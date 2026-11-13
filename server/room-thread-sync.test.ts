import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createGroupRoutes } from "./group-routes.ts";
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
