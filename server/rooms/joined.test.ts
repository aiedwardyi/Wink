import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import {
  addJoinedEntries,
  closeJoinedDb,
  endJoined,
  joinedEntries,
  joinedHead,
  joinedKey,
  joinedRoom,
  joinedRooms,
  resetJoined,
  saveJoined,
  setJoinedState,
  type JoinedEntry,
  type JoinedState,
} from "./joined.ts";

const KEY = `wkg_${"k".repeat(43)}`;
const HOST = "abcdefghijklmnop.wink.test";
const ME = { id: "p1", name: "Mina" };

const entry = (seq: number, text = `line ${seq}`): JoinedEntry => ({ seq, id: `e${seq}`, at: seq, author: { kind: "host", id: "host", name: "Edward" }, text });
const state = (version: number, roomName = "Team"): JoinedState => ({ version, roomName, instructions: "", host: "Edward", me: ME, people: [ME] });

beforeAll(() => mkdirSync(DATA_DIR, { recursive: true }));
afterEach(() => closeJoinedDb());

describe("joined.db", () => {
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
    expect(joinedHead("r1")).toBe(3);
  });

  it("keeps the highest state version", () => {
    saveJoined("r1", HOST, ME, KEY);
    expect(setJoinedState("r1", state(5, "New"))).toBe(true);
    expect(setJoinedState("r1", state(4, "Old"))).toBe(false);
    expect(joinedRoom("r1")?.state?.roomName).toBe("New");
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
});
