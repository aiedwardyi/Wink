import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { addPerson, closeRoomsDb, createRoom, RoomError, roomPeople } from "./db.ts";
import {
  cancelInvite, closeInvitesDb, createInvite, guestByKey, INVITE_TTL_MS, joinRoom, revokeGuestKeys, roomInvites,
} from "./invites.ts";

const DAY = 24 * 60 * 60_000;
const TAKEN = ["Edward", "Wink"];
const FILE = () => join(DATA_DIR, "rooms.db");

let clock = Date.UTC(2026, 0, 1);
let roomId: string;

const raw = () => new DatabaseSync(FILE());

beforeEach(() => {
  closeInvitesDb();
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  // Later every case, so the module's join bucket always starts full.
  clock += 30 * DAY;
  vi.setSystemTime(clock);
  roomId = createRoom("Team").id;
});
afterEach(() => {
  vi.useRealTimers();
  closeInvitesDb();
  closeRoomsDb();
});

describe("invites", () => {
  it("creates, lists and cancels, never listing the secret", () => {
    const { invite, secret } = createInvite(roomId, "Mina", "ask", TAKEN);
    expect(secret).toMatch(/^wki_[A-Za-z0-9_-]{43}$/);
    expect(roomInvites(roomId)).toEqual([{ id: invite.id, name: "Mina", level: "ask", createdAt: clock, expiresAt: clock + 7 * DAY }]);
    expect(cancelInvite(createRoom("Other").id, invite.id)).toBe(false);
    expect(cancelInvite(roomId, invite.id)).toBe(true);
    expect(roomInvites(roomId)).toEqual([]);
    expect(joinRoom(invite.id, secret, TAKEN)).toEqual({ ok: false, error: "no-invite" });
  });

  it("refuses a name the room, its people or a live invite already has", () => {
    addPerson(roomId, "Jun", "chat", TAKEN);
    createInvite(roomId, "Mina", "chat", TAKEN);
    for (const name of ["wink", "JUN", "mina", "everyone", "a@b"]) {
      expect(() => createInvite(roomId, name, "chat", TAKEN)).toThrow(RoomError);
    }
    expect(() => createInvite("no-room", "Sora", "chat", TAKEN)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("works once", () => {
    const { invite, secret } = createInvite(roomId, "Mina", "trusted", TAKEN);
    const joined = joinRoom(invite.id, secret, TAKEN);
    expect(joined).toMatchObject({ ok: true, roomId, person: { name: "Mina", level: "trusted" } });
    expect(joinRoom(invite.id, secret, TAKEN)).toEqual({ ok: false, error: "no-invite" });
    expect(roomPeople(roomId).map((person) => person.name)).toEqual(["Mina"]);
    expect(roomInvites(roomId)).toEqual([]);
  });

  it("lasts 7 days", () => {
    const early = createInvite(roomId, "Mina", "chat", TAKEN);
    const late = createInvite(roomId, "Jun", "chat", TAKEN);
    vi.setSystemTime(clock + INVITE_TTL_MS - 1);
    expect(joinRoom(early.invite.id, early.secret, TAKEN)).toMatchObject({ ok: true });
    vi.setSystemTime(clock + INVITE_TTL_MS);
    expect(roomInvites(roomId)).toEqual([]);
    expect(joinRoom(late.invite.id, late.secret, TAKEN)).toEqual({ ok: false, error: "no-invite" });
  });

  it("dies after 5 wrong secrets, counted across restarts", () => {
    const { invite, secret } = createInvite(roomId, "Mina", "chat", TAKEN);
    for (const wrong of ["", "wki_nope", secret.slice(0, -1), `${secret}x`]) {
      expect(joinRoom(invite.id, wrong, TAKEN)).toEqual({ ok: false, error: "wrong-secret" });
      closeInvitesDb();
    }
    expect(joinRoom(invite.id, "x".repeat(10_000), TAKEN)).toEqual({ ok: false, error: "too-many-tries" });
    expect(joinRoom(invite.id, secret, TAKEN)).toEqual({ ok: false, error: "no-invite" });
    expect(roomPeople(roomId)).toEqual([]);
  });

  it("takes 20 joins a minute", () => {
    for (let i = 0; i < 20; i++) expect(joinRoom("nope", "wki_nope", TAKEN)).toEqual({ ok: false, error: "no-invite" });
    const { invite, secret } = createInvite(roomId, "Mina", "chat", TAKEN);
    expect(joinRoom(invite.id, secret, TAKEN)).toEqual({ ok: false, error: "busy" });
    vi.setSystemTime(clock + 60_000);
    expect(joinRoom(invite.id, secret, TAKEN)).toMatchObject({ ok: true });
  });

  it("keeps the invite when the room is full or the name was taken since", () => {
    const { invite, secret } = createInvite(roomId, "Mina", "chat", TAKEN);
    expect(joinRoom(invite.id, secret, [...TAKEN, "MINA"])).toEqual({ ok: false, error: "name-taken" });
    for (let i = 0; i < 20; i++) addPerson(roomId, `P${i}`, "chat", TAKEN);
    expect(joinRoom(invite.id, secret, TAKEN)).toEqual({ ok: false, error: "room-full" });
    expect(roomInvites(roomId)).toHaveLength(1);
  });

  it("leaves no key and no person when join fails midway", () => {
    const { invite, secret } = createInvite(roomId, "Mina", "chat", TAKEN);
    const database = raw();
    database.exec("CREATE TRIGGER crash BEFORE INSERT ON guest_keys BEGIN SELECT RAISE(ABORT, 'crash'); END");
    expect(() => joinRoom(invite.id, secret, TAKEN)).toThrow("crash");
    expect(roomPeople(roomId)).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS n FROM guest_keys").get()).toEqual({ n: 0 });
    expect(roomInvites(roomId)).toHaveLength(1);
    database.exec("DROP TRIGGER crash");
    database.close();
    expect(joinRoom(invite.id, secret, TAKEN)).toMatchObject({ ok: true });
  });
});

describe("guest keys", () => {
  const join1 = (name = "Mina") => {
    const { invite, secret } = createInvite(roomId, name, "ask", TAKEN);
    const joined = joinRoom(invite.id, secret, TAKEN);
    if (!joined.ok) throw new Error(joined.error);
    return { ...joined, secret };
  };

  it("maps a key to its room and person", () => {
    const { key, person } = join1();
    expect(key).toMatch(/^wkg_[A-Za-z0-9_-]{43}$/);
    expect(guestByKey(key)).toEqual({ roomId, person });
    for (const wrong of ["", key.slice(0, -1), `${key}x`, key.replace("wkg_", "wkd_")]) expect(guestByKey(wrong)).toBeNull();
  });

  it("stores only hashes", () => {
    const { key, secret } = join1();
    const pending = createInvite(roomId, "Jun", "chat", TAKEN);
    closeInvitesDb();
    closeRoomsDb();
    const database = raw();
    const rows = JSON.stringify([
      database.prepare("SELECT * FROM invites").all(),
      database.prepare("SELECT * FROM guest_keys").all(),
    ]);
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(rows).toContain(sha(key));
    expect(rows).toContain(sha(pending.secret));
    database.close();
    for (const file of [FILE(), `${FILE()}-wal`].filter(existsSync)) {
      const bytes = readFileSync(file, "latin1");
      for (const value of [key, secret, pending.secret]) expect(bytes).not.toContain(value.slice(4));
    }
  });

  it("revoke kills the key and only that key", () => {
    const mina = join1();
    const jun = join1("Jun");
    expect(revokeGuestKeys(roomId, mina.person.id)).toBe(true);
    expect(guestByKey(mina.key)).toBeNull();
    expect(guestByKey(jun.key)).toEqual({ roomId, person: jun.person });
    expect(revokeGuestKeys(roomId, mina.person.id)).toBe(false);
  });

  it("fails without its person", () => {
    const { key, person } = join1();
    const database = raw();
    database.prepare("DELETE FROM people WHERE id = ?").run(person.id);
    database.close();
    expect(guestByKey(key)).toBeNull();
  });
});
