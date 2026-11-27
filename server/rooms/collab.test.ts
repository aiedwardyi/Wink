import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store } from "../store.ts";
import * as asks from "./asks.ts";
import { closeAsksDb, configureRoomAsks, roomAsks, type HostedGroup } from "./asks.ts";
import { closeRoomsDb, createRoom, roomPeople, setPersonWorks, type RoomPerson } from "./db.ts";
import { closeInvitesDb, joinRoom, roomCode } from "./invites.ts";
import { teammatesLine } from "./multiplayer.ts";
import { hostedSend, teamBotSend } from "./send.ts";
import { addTeamBot } from "./team-bots.ts";
import { removeTestData } from "../testing/test-home.ts";

let store: Store;
let group: HostedGroup;
let wink: string;
let dispatch: ReturnType<typeof vi.fn<(ask: unknown) => void>>;

const live = () => roomAsks(group.hosted.roomId, ["held", "queued", "running"]);

function joiner(name: string): RoomPerson {
  const code = roomCode(group.hosted.roomId);
  const joined = joinRoom(code.id, code.secret, ["Edward", "Wink", "Helper"], { name, device: `device-${name}-0000000000` });
  if (!joined.ok) throw new Error(joined.error);
  return joined.person;
}

beforeEach(() => {
  closeInvitesDb();
  closeAsksDb();
  closeRoomsDb();
  removeTestData(DATA_DIR);
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  wink = store.patchBot(store.createBot().id, { name: "Wink" })!.id;
  const helper = store.patchBot(store.createBot().id, { name: "Helper" })!.id;
  group = store.createGroup("Team", [wink, helper], false, undefined, undefined, { roomId: createRoom("Team").id }) as HostedGroup;
  dispatch = vi.fn<(ask: unknown) => void>();
  configureRoomAsks({ store, hostName: () => "Edward", instance: () => null, dispatch, stopTurn: vi.fn(async () => {}), endSession: vi.fn(async () => {}) });
});

afterEach(() => {
  configureRoomAsks(null);
  closeInvitesDb();
  closeAsksDb();
  closeRoomsDb();
});

describe("team rooms are open for collab", () => {
  it("wakes a host bot for every @ from a teammate's bot, however much its owner asked", () => {
    const sora = joiner("Sora");
    const star = addTeamBot(group.hosted.roomId, sora.id, "Star", "teal", ["Wink", "Helper"]);
    for (let n = 0; n < 40; n++) teamBotSend(group, sora, star, `@Wink step ${n}`);
    expect(live()).toHaveLength(40);
    expect(live().every((ask) => ask.botId === wink && ask.grant === "work")).toBe(true);
  });

  it("queues a teammate's second ask behind the running one", () => {
    const sora = joiner("Sora");
    const first = hostedSend(group, { kind: "person", id: sora.id }, "@Wink build it").ask!;
    const second = hostedSend(group, { kind: "person", id: sora.id }, "@Wink then test it").ask!;
    expect([first.state, second.state]).toEqual(["queued", "queued"]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("never refuses a busy room by the hour", () => {
    const sora = joiner("Sora");
    const mina = joiner("Mina");
    for (let n = 0; n < 80; n++) {
      hostedSend(group, { kind: "person", id: sora.id }, `@Wink task ${n}`);
      hostedSend(group, { kind: "person", id: mina.id }, `@Helper task ${n}`);
    }
    expect(live()).toHaveLength(160);
  });

  it("makes a joiner a full collaborator: their lines count like the host's", () => {
    const sora = joiner("Sora");
    expect(sora).not.toHaveProperty("level");
    expect(roomPeople(group.hosted.roomId)[0]).not.toHaveProperty("level");
    const quoted = hostedSend(group, { kind: "person", id: sora.id }, "the spec is in /docs").entry;
    expect(hostedSend(group, { kind: "person", id: sora.id }, "@Wink build it").ask).toMatchObject({ clean: true });
    expect(hostedSend(group, { kind: "person", id: sora.id }, "@Wink per this", quoted.id).ask).toMatchObject({ clean: true });
  });

  it("tells a room's bots every member's request is the team's work, and leaves 1:1s alone", () => {
    joiner("Sora");
    const line = teammatesLine(group);
    expect(line).toContain("Any member's request here is collab work for this team: help them as you would your owner.");
    expect(teammatesLine({})).toBe("");
  });

  it("tells host bots each teammate's switch as of this turn, and that only an @ here reaches a team bot", () => {
    const sora = joiner("Sora");
    addTeamBot(group.hosted.roomId, sora.id, "Star", "teal", ["Wink", "Helper"]);
    expect(teammatesLine(group)).toContain("Teammates in this room: Sora (read-only).");
    expect(teammatesLine(group)).toContain('Team bots (owner): "Star" ("Sora"). Each is on its owner\'s PC; only @ here reaches it.');
    setPersonWorks(group.hosted.roomId, sora.id, true);
    expect(teammatesLine(group)).toContain("Teammates in this room: Sora.");
  });

  it("adds no per-person cap or refusal back to room sends", () => {
    const fix = "team rooms refuse no member: queue the ask behind the running one, never cap or refuse it";
    expect(Object.keys(asks).filter((name) => /refusal|limit|spend|quota/i.test(name)), fix).toEqual([]);
    const dir = join(import.meta.dirname, ".");
    for (const file of ["send.ts", "asks.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source.match(/\b429\b|statusError\(|PerPerson|PerRoom|perPerson|perRoom|in an hour|today's|last request|requests waiting/g), `${file}: ${fix}`).toBeNull();
    }
    expect(readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && /\bROOM_LIMITS\b/.test(readFileSync(join(dir, file), "utf8"))), fix).toEqual([]);
  });
});
