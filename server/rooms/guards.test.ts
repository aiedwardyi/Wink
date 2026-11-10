import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store } from "../store.ts";
import { closeRoomsDb, createRoom } from "./db.ts";
import { hostedFrame, hostedRelayTarget, hostedRoomView, hostedThreadIds, isHostedThread, roomBotsRefusal } from "./guards.ts";

let store: Store;

beforeEach(() => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
});
afterEach(closeRoomsDb);

describe("team room guards", () => {
  it("lets only Claude or Codex bots into a team room", () => {
    expect(roomBotsRefusal([{ name: "A", driverKind: "claudeAgent" }, { name: "B", driverKind: "codex" }])).toBeNull();
    for (const driverKind of ["grok", "antigravityAgent", "boxAgent", "museAgent", "acp", undefined]) {
      expect(roomBotsRefusal([{ name: "Odd", driverKind }])).toBe("Odd can only answer in team rooms on Claude or Codex");
    }
  });

  it("refuses a bot whose name clashes with a person or another bot", () => {
    expect(roomBotsRefusal([{ name: "Mina", driverKind: "codex" }], ["mina"])).toMatch(/already called Mina/);
    expect(roomBotsRefusal([{ name: "Wink", driverKind: "codex" }, { name: "WINK", driverKind: "claudeAgent" }])).toMatch(/already called WINK/);
  });

  it("tags hosted frames and relay routes, and nothing else", () => {
    const bot = store.createBot();
    const plain = store.createGroup("Plain", [bot.id]);
    const hosted = store.createGroup("Team", [bot.id], false, undefined, undefined, { roomId: "r1" });
    expect(isHostedThread(store, hosted.threadId)).toBe(true);
    expect(isHostedThread(store, plain.threadId)).toBe(false);
    expect(isHostedThread(store, bot.threadId)).toBe(false);
    const deleted: unknown[] = [];
    store.onChange((change) => { if (change.type === "group.deleted") deleted.push(change); });
    const doomed = store.createGroup("Doomed", [bot.id], false, undefined, undefined, { roomId: "r2" });
    store.deleteGroup(doomed.id);
    store.deleteGroup(store.createGroup("Gone", [bot.id]).id);
    expect(deleted).toEqual([{ type: "group.deleted", groupId: doomed.id, hosted: true }, { type: "group.deleted", groupId: expect.any(String) }]);
    expect(deleted[1]).not.toHaveProperty("hosted");
    for (const payload of [
      { kind: "group", group: hosted },
      { kind: "message", threadId: hosted.threadId },
      { kind: "runtime", event: { threadId: hosted.threadId } },
      { kind: "notify", notification: { threadId: hosted.threadId } },
      { kind: "group.deleted", groupId: hosted.id },
      { kind: "group.deleted", groupId: "already-gone", hosted: true },
    ]) expect(hostedFrame(store, payload)).toBe(true);
    for (const payload of [
      { kind: "group", group: plain },
      { kind: "message", threadId: bot.threadId },
      { kind: "bot", bot },
      { kind: "config" },
    ]) expect(hostedFrame(store, payload)).toBe(false);
    expect(hostedRelayTarget(store, `/api/groups/${hosted.id}/messages`)).toBe(true);
    expect(hostedRelayTarget(store, `/api/threads/${hosted.threadId}/respond`)).toBe(true);
    expect(hostedRelayTarget(store, `/api/groups/${plain.id}`)).toBe(false);
    expect(hostedRelayTarget(store, `/api/threads/${bot.threadId}/respond`)).toBe(false);
    expect(hostedRelayTarget(store, "/api/bots")).toBe(false);
    expect(hostedThreadIds(store)).toEqual([hosted.threadId]);
  });

  it("shows a restored room without its data as missing, never empty", () => {
    expect(hostedRoomView({ roomId: "restored-without-rooms-db" })).toEqual({ missing: true });
    const room = createRoom("Team");
    expect(hostedRoomView({ roomId: room.id })).toEqual({ name: "Team", people: [] });
  });
});
