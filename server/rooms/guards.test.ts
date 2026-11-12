import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store } from "../store.ts";
import { appendRoomEntry, closeRoomsDb, createRoom, noticeText } from "./db.ts";
import { hostedRoomView, isHostedThread, roomBotsRefusal } from "./guards.ts";
import { closeInvitesDb } from "./invites.ts";

let store: Store;

const close = () => {
  closeInvitesDb();
  closeRoomsDb();
};

beforeEach(() => {
  close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
});
afterEach(close);

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

  it("gives the host a long pinned line in full, and trims an old long pin on load", () => {
    const room = createRoom("Team");
    const host = { kind: "host", id: "host", name: "Eddie" } as const;
    const long = appendRoomEntry(room.id, { author: host, text: "a".repeat(400) });
    const short = appendRoomEntry(room.id, { author: host, text: "short" });
    expect(hostedRoomView({ roomId: room.id }, { entryId: long.id, by: "host", at: 1, text: noticeText(long.text) })).toMatchObject({ noticeText: long.text });
    expect(hostedRoomView({ roomId: room.id }, { entryId: short.id, by: "host", at: 1, text: "short" })).not.toHaveProperty("noticeText");
    const group = store.createGroup("Team", [store.createBot().id], false, undefined, undefined, { roomId: room.id });
    const file = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; notice?: unknown }>;
    saved.find((candidate) => candidate.id === group.id)!.notice = { entryId: long.id, by: "host", at: 1, text: long.text };
    writeFileSync(file, JSON.stringify(saved));
    expect(new Store(() => ({ instanceId: "fake", model: "m" })).group(group.id)?.notice?.text).toBe(noticeText(long.text));
  });
});
