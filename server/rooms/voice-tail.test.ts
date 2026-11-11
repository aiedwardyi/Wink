import { mkdirSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { estimateContextTokens } from "../context-compaction.ts";
import { addPerson, appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries } from "./db.ts";
import { addJoinedEntries, closeJoinedDb, endJoined, joinedEntries, saveJoined, setJoinedState } from "./joined.ts";
import { roomTail } from "./voice-tail.ts";

beforeAll(() => mkdirSync(DATA_DIR, { recursive: true }));
afterEach(() => { closeRoomsDb(); closeJoinedDb(); });

describe("room voice tail", () => {
  it("reads the host room newest first with people and file names only", () => {
    const room = createRoom("Launch");
    addPerson(room.id, "Minji", "chat", ["Edward"]);
    appendRoomEntry(room.id, { author: { kind: "person", id: "minji", name: "Minji" }, text: "Safari login breaks" });
    appendRoomEntry(room.id, { author: { kind: "host", id: "host", name: "Edward" }, text: "Checking", files: [{ id: "private-file-id", name: "safari.png", type: "image/png", bytes: 100, sha256: "private-hash" }] });
    const before = recentRoomEntries(room.id, 10);
    expect(roomTail({ id: room.id, kind: "host" }, "Edward")).toEqual({ name: "Launch", caller: "Edward", people: ["Edward", "Minji"], tail: "Edward: Checking safari.png\nMinji: Safari login breaks" });
    expect(recentRoomEntries(room.id, 10)).toEqual(before);
  });

  it("reads the joined room using the caller's room name", () => {
    const me = { id: "minji", name: "민지" };
    saveJoined("joined-launch", "fixture.invalid", me, "fixture-key");
    setJoinedState("joined-launch", { version: 1, roomName: "Launch", instructions: "not room chat", host: "Edward", me, people: [me] });
    addJoinedEntries("joined-launch", [{ seq: 1, id: "e1", at: 1, author: { kind: "host", id: "host", name: "Edward" }, text: "Check before 4pm" }]);
    expect(roomTail({ id: "joined-launch", kind: "joined" }, "Other profile name")).toEqual({ name: "Launch", caller: "민지", people: ["Edward", "민지"], tail: "Edward: Check before 4pm" });
    expect(joinedEntries("joined-launch", 10)).toHaveLength(1);
    endJoined("joined-launch", "removed");
    expect(roomTail({ id: "joined-launch", kind: "joined" }, "민지")).toBeUndefined();
  });

  it("caps the room tail at 2,000 tokens, keeping newest lines", () => {
    const room = createRoom("Budget");
    for (let i = 0; i < 120; i++) appendRoomEntry(room.id, { author: { kind: "host", id: "host", name: "Edward" }, text: `line ${i} ${"word ".repeat(30)}` });
    const tail = roomTail({ id: room.id, kind: "host" }, "Edward")!.tail;
    expect(tail).toMatch(/^Edward: line 119 /);
    expect(tail).not.toContain("line 0 ");
    expect(estimateContextTokens([{ text: tail }])).toBeLessThanOrEqual(2_000);
  });

  it("has no brief for a missing room", () => {
    expect(roomTail({ id: "missing", kind: "host" }, "Edward")).toBeUndefined();
    expect(roomTail({ id: "missing", kind: "joined" }, "Edward")).toBeUndefined();
  });
});
