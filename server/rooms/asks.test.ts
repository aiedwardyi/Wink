import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { _resetSteerQueue, drainSteeredMessages, queueRoomParticipation } from "../steer-queue.ts";
import { Store } from "../store.ts";
import {
  admitAsk, askAllowsRequest, askById, closeAsksDb, configureRoomAsks, createAsk, endAsk, failInterruptedAsks, hostedTurnRefused,
  revalidatePersonAsks, roomAsks, ROOM_LIMITS, sendRefusal, spend, startAsk, type HostedGroup, type RoomAsk, type RoomAskDeps,
} from "./asks.ts";
import { addPerson, appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries, type RoomPerson } from "./db.ts";

let store: Store;
let group: HostedGroup;
let botId: string;
let mina: RoomPerson;
let jun: RoomPerson;
let deps: RoomAskDeps;
let order: string[];
let endSession: () => void;

const terminal = () => recentRoomEntries(group.hosted.roomId, 50).filter((entry) => entry.author.kind === "bot").map((entry) => entry.text);

function ask(asker: RoomPerson | "host", grant: RoomAsk["grant"] | "held" = "work"): RoomAsk {
  const author = asker === "host" ? { kind: "host" as const, id: "host", name: "Edward" } : { kind: "person" as const, id: asker.id, name: asker.name };
  const entry = appendRoomEntry(group.hosted.roomId, { author, text: "@Wink do it" });
  return createAsk({
    roomId: group.hosted.roomId, threadId: group.threadId, botId, entryId: entry.id, clean: asker === "host",
    asker: asker === "host" ? { kind: "host", id: "host" } : { kind: "person", id: asker.id },
    ...(grant === "held" ? {} : { grant }),
  });
}

beforeEach(() => {
  closeRoomsDb();
  closeAsksDb();
  _resetSteerQueue();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  botId = store.patchBot(store.createBot().id, { name: "Wink" })!.id;
  group = store.createGroup("Team", [botId], false, undefined, undefined, { roomId: createRoom("Team").id }) as HostedGroup;
  mina = addPerson(group.hosted.roomId, "Mina", "trusted", ["Wink"]);
  jun = addPerson(group.hosted.roomId, "Jun", "trusted", ["Wink"]);
  order = [];
  deps = {
    store,
    teamRooms: () => true,
    hostName: () => "Edward",
    driverKind: () => "claudeAgent",
    instance: () => null,
    dispatch: vi.fn(),
    stopTurn: vi.fn(async (stopped: RoomAsk) => { order.push(`interrupt while ${askById(stopped.id)!.state}`); }),
    endSession: vi.fn(() => new Promise<void>((resolve) => { endSession = () => { order.push("endSession"); resolve(); }; })),
  };
  configureRoomAsks(deps);
});
afterEach(() => {
  configureRoomAsks(null);
  closeAsksDb();
  closeRoomsDb();
});

describe("ask states", () => {
  it("starts held without a grant and queued with one", () => {
    expect(ask(mina, "held").state).toBe("held");
    expect(ask(mina).state).toBe("queued");
  });

  it("lets only one of two racing moves land", async () => {
    const queued = ask(mina);
    const [first, second] = await Promise.all([endAsk(queued.id, "cancelled"), endAsk(queued.id, "failed")]);
    expect([first, second]).toEqual([true, false]);
    expect(askById(queued.id)!.state).toBe("cancelled");
    expect(terminal()).toEqual(["Cancelled."]);
    expect(startAsk(queued.id)).toBe(false);
  });

  it("refuses an Allow that lands after Cancel", async () => {
    const held = ask(mina, "held");
    await endAsk(held.id, "cancelled");
    expect(admitAsk(held.id, "work")).toBeNull();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("takes stopping before the interrupt on Cancel and writes the entry only after endSession", async () => {
    const running = ask(mina);
    expect(startAsk(running.id)).toBe(true);
    const ended = endAsk(running.id, "cancelled");
    expect(askById(running.id)!.state).toBe("stopping");
    expect(askAllowsRequest(running.id)).toBe(false);
    await vi.waitFor(() => expect(deps.endSession).toHaveBeenCalled());
    expect(terminal()).toEqual([]);
    endSession();
    expect(await ended).toBe(true);
    expect(order).toEqual(["interrupt while stopping", "endSession"]);
    expect(askById(running.id)!.state).toBe("cancelled");
    expect(terminal()).toEqual(["Cancelled."]);
  });

  it("ends a running ask on the deadline the same way, with the failed line", async () => {
    const running = ask("host");
    startAsk(running.id);
    const ended = endAsk(running.id, "failed");
    expect(askById(running.id)!.state).toBe("stopping");
    await vi.waitFor(() => expect(deps.endSession).toHaveBeenCalled());
    endSession();
    await ended;
    expect(terminal()).toEqual(["Wink couldn't finish this."]);
  });

  it("drops a level and ends work the new level no longer covers", async () => {
    const running = ask(mina);
    startAsk(running.id);
    const words = ask(jun, "words");
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(`${DATA_DIR}/rooms.db`);
    raw.prepare("UPDATE people SET level = 'chat' WHERE id IN (?, ?)").run(mina.id, jun.id);
    raw.close();
    const done = revalidatePersonAsks(group.hosted.roomId, mina.id);
    expect(askById(running.id)!.state).toBe("stopping");
    await vi.waitFor(() => expect(deps.endSession).toHaveBeenCalled());
    endSession();
    await done;
    expect(askById(running.id)!.state).toBe("cancelled");
    await revalidatePersonAsks(group.hosted.roomId, jun.id);
    expect(askById(words.id)!.state).toBe("queued");
  });

  it("cancels a queued ask when its person is removed, and its queue item with it", async () => {
    const queued = ask(mina);
    queueRoomParticipation(botId, group.threadId, { groupId: group.id, askId: queued.id });
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(`${DATA_DIR}/rooms.db`);
    raw.prepare("DELETE FROM people WHERE id = ?").run(mina.id);
    raw.close();
    await revalidatePersonAsks(group.hosted.roomId, mina.id);
    expect(askById(queued.id)!.state).toBe("cancelled");
    const run = vi.fn();
    drainSteeredMessages({ bot: (id) => store.bot(id), messagesFor: () => [], appendMessage: vi.fn(), patchMessage: vi.fn() }, run);
    expect(run).not.toHaveBeenCalled();
    expect(deps.stopTurn).not.toHaveBeenCalled();
  });
});

describe("the central guard", () => {
  it("refuses a hosted thread without a live ask for this room, thread and bot", async () => {
    expect(hostedTurnRefused(group, group.threadId, botId)).toBe(true);
    expect(hostedTurnRefused(group, group.threadId, botId, "no-such-ask")).toBe(true);
    const queued = ask(mina);
    expect(hostedTurnRefused(group, group.threadId, "other-bot", queued.id)).toBe(true);
    expect(hostedTurnRefused(group, "other-thread", botId, queued.id)).toBe(true);
    expect(hostedTurnRefused(group, group.threadId, botId, queued.id)).toBe(false);
    await endAsk(queued.id, "cancelled");
    expect(hostedTurnRefused(group, group.threadId, botId, queued.id)).toBe(true);
  });

  it("ignores threads that aren't hosted", () => {
    const plain = store.createGroup("Plain", [botId]);
    expect(hostedTurnRefused(plain, plain.threadId, botId)).toBe(false);
    expect(hostedTurnRefused(undefined, "x", botId)).toBe(false);
  });

  it("ends an ask whose bot left the engines rooms run on", () => {
    const queued = ask("host");
    deps.driverKind = () => "grokAgent";
    expect(hostedTurnRefused(group, group.threadId, botId, queued.id)).toBe(true);
    expect(askById(queued.id)!.state).toBe("failed");
    expect(terminal()).toEqual(["Wink can only answer in team rooms on Claude or Codex"]);
  });
});

describe("boot", () => {
  it("fails queued, running and stopping asks and keeps held ones", () => {
    const held = ask(mina, "held");
    const queued = ask(mina);
    const running = ask(jun);
    startAsk(running.id);
    const stopping = ask("host");
    startAsk(stopping.id);
    void endAsk(stopping.id, "cancelled");
    closeAsksDb();
    expect(failInterruptedAsks()).toBe(3);
    expect([held, queued, running, stopping].map((row) => askById(row.id)!.state)).toEqual(["held", "failed", "failed", "failed"]);
    expect(terminal()).toEqual(Array(3).fill("Stopped: Edward's PC restarted. Ask again."));
  });

  it("creates no rooms.db when there is none", () => {
    closeRoomsDb();
    closeAsksDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `rooms.db${suffix}`), { force: true });
    expect(failInterruptedAsks()).toBe(0);
    expect(existsSync(join(DATA_DIR, "rooms.db"))).toBe(false);
  });
});

describe("quotas and open-ask limits", () => {
  it("survive a restart", () => {
    for (let i = 0; i < ROOM_LIMITS.asksPerPersonHour; i++) spend(group.hosted.roomId, mina.id, "ask");
    closeAsksDb();
    closeRoomsDb();
    expect(sendRefusal(group.hosted.roomId, mina.id, "words")).toMatch(/in an hour/);
    expect(sendRefusal(group.hosted.roomId, mina.id, null)).toBeNull();
    for (let i = 0; i < ROOM_LIMITS.messagesPerPersonDay; i++) spend(group.hosted.roomId, mina.id, "message");
    closeAsksDb();
    expect(sendRefusal(group.hosted.roomId, mina.id, null)).toMatch(/today's limit/);
  });

  it("holds one open work ask and three held asks per person", () => {
    ask(mina);
    expect(sendRefusal(group.hosted.roomId, mina.id, "work")).toMatch(/last request/);
    expect(sendRefusal(group.hosted.roomId, jun.id, "work")).toBeNull();
    for (let i = 0; i < 3; i++) ask(jun, "held");
    expect(sendRefusal(group.hosted.roomId, jun.id, "held")).toMatch(/3 requests/);
  });

  it("counts an Allowed ask for its asker", () => {
    const held = ask(mina, "held");
    expect(admitAsk(held.id, "work")).toMatchObject({ state: "queued", grant: "work", allowed: true });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(admitAsk(held.id, "work")).toBeNull();
    expect(roomAsks(group.hosted.roomId, ["queued"])).toHaveLength(1);
    for (let i = 1; i < ROOM_LIMITS.asksPerPersonHour; i++) spend(group.hosted.roomId, mina.id, "ask");
    expect(sendRefusal(group.hosted.roomId, mina.id, "words")).toMatch(/in an hour/);
  });
});
