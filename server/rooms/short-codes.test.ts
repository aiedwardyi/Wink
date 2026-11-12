import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { addPerson, closeRoomsDb, createRoom } from "./db.ts";
import { barRoomPerson, closeInvitesDb, joinRoom, roomCode, shortCodeTarget, shortRoomCode } from "./invites.ts";

const DAY = 24 * 60 * 60_000;
const DEVICE = "device-0123456789abcdef";

let clock = Date.UTC(2026, 0, 1);
let roomId: string;

beforeEach(() => {
  closeInvitesDb();
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 30 * DAY;
  vi.setSystemTime(clock);
  roomId = createRoom("Team").id;
});
afterEach(() => {
  vi.useRealTimers();
  closeInvitesDb();
  closeRoomsDb();
});

const minter = (...codes: string[]) => vi.fn(async () => {
  const code = codes.shift();
  return code ? { code, exp: Date.now() + 7 * DAY } : null;
});

describe("short room codes", () => {
  it("mints once and shows the same code while it has a day left", async () => {
    const mint = minter("ABCDEF", "GHJKLM");
    expect(await shortRoomCode(roomId, mint)).toBe("ABCDEF");
    vi.setSystemTime(clock + 5 * DAY);
    expect(await shortRoomCode(roomId, mint)).toBe("ABCDEF");
    expect(mint).toHaveBeenCalledTimes(1);
    vi.setSystemTime(clock + 6.5 * DAY);
    expect(await shortRoomCode(roomId, mint)).toBe("GHJKLM");
    expect(shortCodeTarget("ABCDEF")).toEqual(roomCode(roomId));
  });

  it("falls back to null when the relay mints nothing", async () => {
    expect(await shortRoomCode(roomId, minter())).toBeNull();
  });

  it("caps a relay expiry at seven days", async () => {
    await shortRoomCode(roomId, async () => ({ code: "ABCDEF", exp: Date.now() + 365 * DAY }));
    vi.setSystemTime(clock + 7 * DAY + 1);
    expect(shortCodeTarget("ABCDEF")).toBeNull();
  });

  it("maps a live code to the room code, case-insensitively, and joins with it", async () => {
    await shortRoomCode(roomId, minter("ABCDEF"));
    const target = shortCodeTarget("abcdef")!;
    expect(target).toEqual(roomCode(roomId));
    expect(joinRoom(target.id, target.secret, [], { name: "Mina", device: DEVICE })).toMatchObject({ ok: true, roomId });
  });

  it("refuses an expired, unknown or malformed code", async () => {
    await shortRoomCode(roomId, minter("ABCDEF"));
    for (const bad of ["ABCDEG", "ABCDE", "ABCDE0", ""]) expect(shortCodeTarget(bad)).toBeNull();
    vi.setSystemTime(clock + 7 * DAY);
    expect(shortCodeTarget("ABCDEF")).toBeNull();
  });

  it("dies with the room code a Remove retires", async () => {
    await shortRoomCode(roomId, minter("ABCDEF", "GHJKLM"));
    const person = addPerson(roomId, "Mina", "chat", []);
    barRoomPerson(roomId, person.id);
    expect(shortCodeTarget("ABCDEF")).toBeNull();
    expect(await shortRoomCode(roomId, minter("GHJKLM"))).toBe("GHJKLM");
    expect(shortCodeTarget("GHJKLM")).toEqual(roomCode(roomId));
  });
});
