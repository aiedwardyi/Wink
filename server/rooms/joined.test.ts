import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import {
  addJoinedEntries,
  closeJoinedDb,
  endJoined,
  joinedEntries,
  joinedEntry,
  joinedCursor,
  joinedKey,
  joinedRoom,
  joinedRooms,
  myRoomBots,
  resetJoined,
  saveJoined,
  saveMyRoomBot,
  setJoinedState,
  type JoinedEntry,
  type JoinedState,
} from "./joined.ts";

const KEY = `wkg_${"k".repeat(43)}`;
const HOST = "abcdefghijklmnop.wink.test";
const ME = { id: "p1", name: "Mina" };

const entry = (seq: number, text = `line ${seq}`): JoinedEntry => ({ seq, id: `e${seq}`, at: seq, author: { kind: "host", id: "host", name: "Edward" }, text });
const state = (version: number, roomName = "Team"): JoinedState => ({ version, roomName, instructions: "", host: "Edward", me: ME, people: [ME], bots: [] });
const WINK = { id: "b1", name: "Wink", color: "blue" };
/** A state held by a build from before bots in rooms. */
const heldState = (version: number) => {
  const { bots: _bots, ...held } = state(version);
  return held as JoinedState;
};

beforeAll(() => mkdirSync(DATA_DIR, { recursive: true }));
afterEach(() => closeJoinedDb());

describe("joined.db", () => {
  it("finds held entry ids through an index", () => {
    saveJoined("r1", HOST, ME, KEY);
    addJoinedEntries("r1", [entry(1)]);
    expect(joinedEntry("r1", "e1")?.text).toBe("line 1");
    const database = new DatabaseSync(join(DATA_DIR, "joined.db"), { readOnly: true });
    try {
      const plan = database.prepare("EXPLAIN QUERY PLAN SELECT body FROM entries WHERE room_id = ? AND json_extract(body, '$.id') = ? LIMIT 1").all("r1", "e1");
      expect(JSON.stringify(plan)).toContain("USING INDEX entries_id");
    } finally { database.close(); }
  });

  it.skipIf(process.platform === "win32")("is created owner-only", () => {
    saveJoined("r1", HOST, ME, KEY);
    expect(statSync(join(DATA_DIR, "joined.db")).mode & 0o777).toBe(0o600);
  });

  it("keeps entries once per seq, in seq order", () => {
    saveJoined("r1", HOST, ME, KEY);
    expect(addJoinedEntries("r1", [entry(2), entry(1)])).toBe(2);
    expect(addJoinedEntries("r1", [entry(2, "again"), entry(3)])).toBe(1);
    expect(joinedEntries("r1", 10).map((row) => [row.seq, row.text])).toEqual([[1, "line 1"], [2, "line 2"], [3, "line 3"]]);
    expect(joinedEntries("r1", 2).map((row) => row.seq)).toEqual([2, 3]);
    expect(joinedCursor("r1")).toBe(0);
    addJoinedEntries("r1", [entry(5)], 5);
    addJoinedEntries("r1", [entry(4)], 4);
    expect(joinedCursor("r1")).toBe(5);
  });

  it("keeps the highest state version", () => {
    saveJoined("r1", HOST, ME, KEY);
    expect(setJoinedState("r1", state(5, "New"))).toBe(true);
    expect(setJoinedState("r1", state(4, "Old"))).toBe(false);
    expect(joinedRoom("r1")?.state?.roomName).toBe("New");
  });

  it("returns the saved reply id with a joined line", () => {
    saveJoined("reply-room", HOST, ME, KEY);
    addJoinedEntries("reply-room", [entry(1), { ...entry(2), replyToId: "e1" }]);
    expect(joinedEntries("reply-room", 10)[1]?.replyToId).toBe("e1");
  });

  it("reset drops the copy and the state", () => {
    saveJoined("r1", HOST, ME, KEY);
    addJoinedEntries("r1", [entry(1)]);
    setJoinedState("r1", state(5));
    resetJoined("r1");
    expect(joinedEntries("r1", 10)).toEqual([]);
    expect(joinedRoom("r1")?.state).toBeNull();
    expect(setJoinedState("r1", state(5))).toBe(true);
  });

  it("an ended room is read-only and keeps no key", () => {
    saveJoined("r1", HOST, ME, KEY);
    addJoinedEntries("r1", [entry(1)]);
    expect(joinedKey("r1")).toEqual({ relayHost: HOST, key: KEY });
    expect(endJoined("r1", "removed")).toBe(true);
    expect(endJoined("r1", "left")).toBe(false);
    expect(joinedKey("r1")).toBeNull();
    expect(setJoinedState("r1", state(9))).toBe(false);
    expect(joinedRoom("r1")).toMatchObject({ status: "removed" });
    expect(joinedEntries("r1", 10)).toHaveLength(1);
    expect(JSON.stringify(joinedRooms())).not.toContain(KEY);
  });

  it("keeps this PC's bots when the host takes the same person back, not a new one", () => {
    saveJoined("r1", HOST, { id: "p0", name: "Old" }, KEY);
    saveJoined("r1", HOST, ME, KEY);
    saveMyRoomBot("r1", "tb-AAAAAAAAAAAAAAAA", "local-pete");
    endJoined("r1", "left");
    saveJoined("r1", HOST, ME, KEY);
    expect(myRoomBots("r1").map((bot) => bot.botId)).toEqual(["local-pete"]);
    saveJoined("r1", HOST, { id: "p2", name: "Mina" }, KEY);
    expect(myRoomBots("r1")).toEqual([]);
  });
});

describe("a copy held from before bot lines", () => {
  it("reads a held bot alias as that bot and a held state without bots as none", () => {
    saveJoined("r1", HOST, ME, KEY);
    setJoinedState("r1", heldState(5));
    addJoinedEntries("r1", [entry(1), { ...entry(2, "on it"), author: { kind: "person", id: "bot-b1", name: "Wink" } }]);
    expect(joinedEntries("r1", 10).map((row) => row.author)).toEqual([
      { kind: "host", id: "host", name: "Edward" },
      { kind: "bot", id: "b1", name: "Wink" },
    ]);
    expect(joinedRoom("r1")?.state?.bots).toEqual([]);
  });

  it("takes the bot roster at the version a pre-bots copy already holds", () => {
    saveJoined("r1", HOST, ME, KEY);
    expect(setJoinedState("r1", heldState(5))).toBe(true);
    expect(setJoinedState("r1", { ...state(5), bots: [WINK] })).toBe(true);
    expect(setJoinedState("r1", { ...state(5), bots: [WINK] })).toBe(false);
    expect(joinedRoom("r1")?.state?.bots).toEqual([WINK]);
  });
});

describe("a copy held from before teammates' bots", () => {
  it.each([false, true])("takes teammates' bots after the host upgraded first (host bot %s)", (withBot) => {
    const bots = withBot ? [WINK] : [];
    saveJoined("r1", HOST, ME, KEY);
    setJoinedState("r1", { ...state(4), bots });
    const incoming = { ...state(5), bots, teamBots: [] };
    const { teamBots: _teamBots, ...held } = incoming;
    expect(setJoinedState("r1", held)).toBe(true);
    expect(joinedRoom("r1")?.state?.teamBots).toBeUndefined();
    expect(setJoinedState("r1", incoming)).toBe(true);
    expect(joinedRoom("r1")?.state?.teamBots).toEqual([]);
    expect(setJoinedState("r1", incoming)).toBe(false);
  });

  it("takes a populated teammate roster at the held version", () => {
    saveJoined("r1", HOST, ME, KEY);
    setJoinedState("r1", state(5));
    const teamBots = [{ ...WINK, owner: ME.id }];
    expect(setJoinedState("r1", { ...state(5), teamBots })).toBe(true);
    expect(joinedRoom("r1")?.state?.teamBots).toEqual(teamBots);
    expect(setJoinedState("r1", { ...state(5), teamBots: [] })).toBe(false);
    expect(joinedRoom("r1")?.state?.teamBots).toEqual(teamBots);
  });

  it("keeps an old host's equal-version state unchanged", () => {
    saveJoined("r1", HOST, ME, KEY);
    setJoinedState("r1", state(5));
    expect(setJoinedState("r1", state(5, "Changed"))).toBe(false);
    expect(joinedRoom("r1")?.state).toMatchObject({ roomName: "Team", bots: [] });
    expect(joinedRoom("r1")?.state?.teamBots).toBeUndefined();
  });

  it("never repairs a roster from an older version", () => {
    saveJoined("r1", HOST, ME, KEY);
    setJoinedState("r1", state(5));
    expect(setJoinedState("r1", { ...state(4), teamBots: [] })).toBe(false);
    expect(joinedRoom("r1")?.state?.teamBots).toBeUndefined();
  });

  it("takes the roster on a fresh join and a newer state", () => {
    saveJoined("r1", HOST, ME, KEY);
    expect(setJoinedState("r1", { ...state(5), teamBots: [] })).toBe(true);
    expect(joinedRoom("r1")?.state?.teamBots).toEqual([]);
    saveJoined("r1", HOST, ME, KEY);
    setJoinedState("r1", state(4));
    expect(setJoinedState("r1", { ...state(5), teamBots: [] })).toBe(true);
    expect(joinedRoom("r1")?.state?.teamBots).toEqual([]);
  });
});
