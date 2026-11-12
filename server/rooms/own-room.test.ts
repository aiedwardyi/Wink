import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { GroupRecord } from "../store.ts";
import { addPerson, appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries, roomPeople } from "./db.ts";
import { closeInvitesDb, roomCode, shortRoomCode } from "./invites.ts";
import { addJoinedEntries, closeJoinedDb, joinedEntries, joinedRoom, joinedRooms, saveJoined } from "./joined.ts";
import { dropOwnJoins, ownRoomGroup } from "./own-room.ts";

const HOST = "abcdefghijklmnop.wink.test";
const KEY = `wkg_${"k".repeat(43)}`;

let roomId: string;
let groups: GroupRecord[];

const close = () => {
  closeInvitesDb();
  closeRoomsDb();
  closeJoinedDb();
};

beforeEach(() => {
  close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  roomId = createRoom("TK").id;
  groups = [{ id: "g-tk", hosted: { roomId } } as GroupRecord];
});
afterEach(close);

describe("ownRoomGroup", () => {
  it("knows this PC's own room by its long or short code", async () => {
    const code = roomCode(roomId);
    expect(ownRoomGroup(` wkr1:${HOST}:${code.id}.${code.secret}\n`, groups)).toBe("g-tk");
    await shortRoomCode(roomId, async () => ({ code: "ABCDEF", exp: Date.now() + 60_000 }));
    expect(ownRoomGroup("abcdef", groups)).toBe("g-tk");
  });

  it("is null for someone else's code, a room no group hosts, or a PC that hosts nothing", () => {
    const code = roomCode(roomId);
    expect(ownRoomGroup(`wkr1:${HOST}:other-id.wki_${"a".repeat(43)}`, groups)).toBeNull();
    expect(ownRoomGroup("GHJKLM", groups)).toBeNull();
    expect(ownRoomGroup(`wkr1:${HOST}:${code.id}.${code.secret}`, [{ id: "g-other", hosted: { roomId: "gone" } } as GroupRecord])).toBeNull();
    expect(ownRoomGroup(`wkr1:${HOST}:${code.id}.${code.secret}`, [])).toBeNull();
  });
});

describe("dropOwnJoins", () => {
  it("drops this PC's joined copy of its own room and its seat, and keeps the hosted lines and other rooms", () => {
    const mina = addPerson(roomId, "Mina", "chat", []);
    const self = addPerson(roomId, "Eddie 2", "chat", []);
    appendRoomEntry(roomId, { author: { kind: "host", id: "host", name: "Eddie" }, text: "hosted line" });
    saveJoined(roomId, HOST, self, KEY);
    addJoinedEntries(roomId, [{ seq: 1, id: "e1", at: 1, author: { kind: "host", id: "host", name: "Eddie" }, text: "joined copy" }]);
    saveJoined("elsewhere", HOST, { id: "p9", name: "Eddie" }, KEY);
    expect(dropOwnJoins(groups)).toEqual([roomId]);
    expect(joinedRoom(roomId)).toBeNull();
    expect(joinedEntries(roomId, 10)).toEqual([]);
    expect(joinedRooms().map((room) => room.roomId)).toEqual(["elsewhere"]);
    expect(roomPeople(roomId)).toEqual([mina]);
    expect(recentRoomEntries(roomId, 10).map((entry) => entry.text)).toEqual(["hosted line"]);
    expect(dropOwnJoins(groups)).toEqual([]);
  });

  it("leaves joined rooms alone on a PC that hosts nothing", () => {
    saveJoined(roomId, HOST, { id: "p1", name: "Eddie" }, KEY);
    expect(dropOwnJoins([])).toEqual([]);
    expect(joinedRoom(roomId)).not.toBeNull();
  });
});
