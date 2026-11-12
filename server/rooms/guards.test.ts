import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store } from "../store.ts";
import { closeRoomsDb, createRoom } from "./db.ts";
import { hostedRoomView, isHostedThread, roomBotsRefusal } from "./guards.ts";

let store: Store;

beforeEach(() => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
});
afterEach(closeRoomsDb);

describe("team room guards", () => {
  it("lets bots on any engine into a team room", () => {
    expect(roomBotsRefusal([{ name: "A" }, { name: "B" }])).toBeNull();
  });

  it("refuses a bot whose name clashes with a person or another bot", () => {
    expect(roomBotsRefusal([{ name: "Mina" }], ["mina"])).toMatch(/already called Mina/);
    expect(roomBotsRefusal([{ name: "Wink" }, { name: "WINK" }])).toMatch(/already called WINK/);
  });

  it("recognizes hosted threads and tags deleted rooms", () => {
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
  });

  it("shows a restored room without its data as missing, never empty", () => {
    expect(hostedRoomView({ roomId: "restored-without-rooms-db" })).toEqual({ missing: true });
    const room = createRoom("Team");
    expect(hostedRoomView({ roomId: room.id })).toEqual({ name: "Team", people: [], joins: [] });
  });
});
