import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { createGroupRoutes } from "../group-routes.ts";
import { Store, type BotRecord, type GroupRecord } from "../store.ts";
import { admitAsk, askAllowsRequest, askById, closeAsksDb, configureRoomAsks, createAsk, hostedTurnRefused, roomAskHooks, roomAsks, runAsk, startAsk, type HostedGroup, type RoomAskDeps } from "./asks.ts";
import { addPerson, appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries, type RoomPerson } from "./db.ts";
import { hostedRoomView } from "./guards.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { hostedSend } from "./send.ts";
import { saveRoomFile } from "./files.ts";

const index = ts.createSourceFile("index.ts", readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
const js = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(node).toBeDefined();
  return new Function(...Object.keys(deps), `${js(node!.getText(index))}\nreturn ${name};`)(...Object.values(deps));
}

let store: Store;
let wink: string;
let deps: RoomAskDeps;
let engine: { sendTurn: ReturnType<typeof vi.fn>; generateText: ReturnType<typeof vi.fn>; generateReview: ReturnType<typeof vi.fn>; answerWords: ReturnType<typeof vi.fn> };

function routes() {
  return createGroupRoutes({
    store,
    instanceForBot: (_bot: BotRecord) => ({ driverKind: "claudeAgent" }),
    checkedMemberIds: (value: unknown) => (Array.isArray(value) && value.length ? { ok: true, memberIds: value } : { ok: false, error: "a channel needs at least one bot" }),
    checkedGroupResponder: () => ({ kind: "everyone" }),
    publicGroupState: (group: GroupRecord) => group,
    groupIsWorking: () => false,
    broadcast: () => {},
  } as unknown as Parameters<typeof createGroupRoutes>[0]);
}

async function call(handler: (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => Promise<unknown>, body: unknown, m: string[] = []) {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await handler(req, res as unknown as ServerResponse, ["", ...m] as RegExpMatchArray);
  return { status: res.writeHead.mock.calls[0][0] as number, body: JSON.parse(res.end.mock.calls[0][0]) };
}

async function peopleRoom(): Promise<HostedGroup> {
  const created = await call(routes().create, { name: "Team", memberIds: [], hosted: true, peopleOnly: true });
  expect(created.status).toBe(201);
  return store.group(created.body.group.id) as HostedGroup;
}

/** An ask row written straight to rooms.db, as stale or tampered data would be. */
function forgedAsk(group: HostedGroup, state: "held" | "queued" | "running", entryId: string): string {
  roomAsks(group.hosted.roomId, ["held"]);
  const db = new DatabaseSync(join(DATA_DIR, "rooms.db"));
  const id = `forged-${state}`;
  db.prepare(`INSERT INTO asks (id, room_id, thread_id, bot_id, asker_kind, asker_id, entry_id, quote_id, grant_kind, allowed, clean, state, reason, at, updated_at)
    VALUES (?, ?, ?, ?, 'host', 'host', ?, NULL, ?, 0, 1, ?, NULL, ?, ?)`).run(id, group.hosted.roomId, group.threadId, wink, entryId, state === "held" ? null : "work", state, Date.now(), Date.now());
  db.close();
  return id;
}

const close = () => {
  configureRoomAsks(null);
  closeAsksDb();
  closeRoomsDb();
};

beforeEach(() => {
  close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  wink = store.patchBot(store.createBot().id, { name: "Wink" })!.id;
  engine = { sendTurn: vi.fn(), generateText: vi.fn(), generateReview: vi.fn(), answerWords: vi.fn() };
  deps = {
    store,
    hostName: () => "Edward",
    driverKind: () => "claudeAgent",
    instance: vi.fn(() => ({ ...engine, adapter: { sendTurn: engine.sendTurn } }) as never),
    dispatch: vi.fn(),
    stopTurn: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
  };
  roomAskHooks.words = vi.fn();
  configureRoomAsks(deps);
});
afterEach(() => {
  delete roomAskHooks.words;
  close();
});

const noWork = () => {
  for (const spy of [deps.dispatch, deps.instance, deps.stopTurn, deps.endSession, roomAskHooks.words!, ...Object.values(engine)]) expect(spy).not.toHaveBeenCalled();
};

describe("people-only room create", () => {
  it("creates a hosted room with zero bots", async () => {
    const group = await peopleRoom();
    expect(group.memberIds).toEqual([]);
    expect(group.hosted.roomId).toBeTruthy();
    expect(peopleOnlyRoom(group.hosted.roomId)).toBe(true);
    expect(hostedRoomView(group.hosted)).toEqual({ name: "Team", people: [], joins: [] });
  });

  it("refuses bots, a missing name and a room that isn't hosted", async () => {
    const before = store.groups.length;
    expect(await call(routes().create, { name: "Team", memberIds: [wink], hosted: true, peopleOnly: true })).toEqual({ status: 400, body: { error: "a people-only room has no bots" } });
    expect(await call(routes().create, { memberIds: [], hosted: true, peopleOnly: true })).toEqual({ status: 400, body: { error: "a people-only room needs a name" } });
    expect((await call(routes().create, { name: "Team", memberIds: [], peopleOnly: true })).status).toBe(400);
    expect((await call(routes().create, { name: "Team", memberIds: [], hosted: true, peopleOnly: false })).status).toBe(400);
    expect((await call(routes().create, { name: "Team", memberIds: [], hosted: true })).status).toBe(400);
    expect(store.groups).toHaveLength(before);
  });

  it("refuses adding a bot afterwards", async () => {
    const group = await peopleRoom();
    expect(await call(routes().patch, { memberIds: [wink] }, [group.id])).toEqual({ status: 409, body: { error: "a people-only room has no bots" } });
    expect(store.group(group.id)!.memberIds).toEqual([]);
  });

  it("never turns an existing bot room into a people-only room", async () => {
    const created = await call(routes().create, { name: "Bots", memberIds: [wink], hosted: true });
    const bots = store.group(created.body.group.id) as HostedGroup;
    expect(peopleOnlyRoom(bots.hosted.roomId)).toBe(false);
    await call(routes().patch, { peopleOnly: true, name: "Bots 2" }, [bots.id]);
    expect(peopleOnlyRoom(bots.hosted.roomId)).toBe(false);
    expect(peopleOnlyRoom(createRoom("Plain row").id)).toBe(false);
  });

  it("keeps the mode across a restart and a restore", async () => {
    const group = await peopleRoom();
    const backup = readFileSync(join(DATA_DIR, "groups.json"), "utf8");
    close();
    store = new Store(() => ({ instanceId: "fake", model: "m" }));
    const reloaded = store.group(group.id) as HostedGroup;
    expect(reloaded.hosted).toEqual(group.hosted);
    expect(peopleOnlyRoom(reloaded.hosted.roomId)).toBe(true);
    store.deleteGroup(group.id);
    close();
    writeFileSync(join(DATA_DIR, "groups.json"), backup);
    store = new Store(() => ({ instanceId: "fake", model: "m" }));
    expect(peopleOnlyRoom((store.group(group.id) as HostedGroup).hosted.roomId)).toBe(true);
    // Backups leave rooms.db out: on a PC without it the room reads as missing and takes no line.
    close();
    rmSync(join(DATA_DIR, "rooms.db"), { force: true });
    rmSync(join(DATA_DIR, "rooms.db-wal"), { force: true });
    rmSync(join(DATA_DIR, "rooms.db-shm"), { force: true });
    store = new Store(() => ({ instanceId: "fake", model: "m" }));
    deps.store = store;
    configureRoomAsks(deps);
    const restored = store.group(group.id) as HostedGroup;
    expect(hostedRoomView(restored.hosted)).toEqual({ missing: true });
    expect(() => hostedSend(restored, { kind: "host" }, "hello")).toThrow(expect.objectContaining({ status: 404 }));
    noWork();
  });
});

describe("a host's room picture", () => {
  it("persists a room image id and clears it without changing the file", async () => {
    const group = await peopleRoom();
    const req = Readable.from([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])]) as IncomingMessage;
    req.headers = {};
    const file = await saveRoomFile(req, group.hosted.roomId, { owner: "host", name: "room.png", uploadId: "picture-upload-01" });
    expect((await call(routes().patch, { picture: file.id }, [group.id])).body.group.picture).toBe(file.id);
    store = new Store(() => ({ instanceId: "fake", model: "m" }));
    expect(store.group(group.id)?.picture).toBe(file.id);
    expect((await call(routes().patch, { picture: null }, [group.id])).body.group.picture).toBeUndefined();
  });

  it("refuses missing, cross-room and non-image files", async () => {
    const group = await peopleRoom();
    const other = await peopleRoom();
    const req = Readable.from([Buffer.from("a text file")]) as IncomingMessage;
    req.headers = {};
    const file = await saveRoomFile(req, other.hosted.roomId, { owner: "host", name: "note.txt", uploadId: "picture-upload-02" });
    for (const [roomId, picture] of [[group.id, file.id], [other.id, file.id], [group.id, "P".repeat(24)], [group.id, "https://example.com/a.png"]]) {
      expect((await call(routes().patch, { picture }, [roomId!])).status).toBe(400);
    }
    expect(group).not.toHaveProperty("picture");
  });
});

describe("a send in a people-only room", () => {
  let group: HostedGroup;
  let mina: RoomPerson;

  beforeEach(async () => {
    group = await peopleRoom();
    mina = addPerson(group.hosted.roomId, "Mina", "trusted", []);
    addPerson(group.hosted.roomId, "민준", "ask", []);
  });

  it("only commits and broadcasts, with 0 model, worker or helper calls", () => {
    const changes: unknown[] = [];
    store.onChange((change) => changes.push(change));
    const first = hostedSend(group, { kind: "person", id: mina.id }, "@Wink fix my PC please");
    const second = hostedSend(group, { kind: "person", id: mina.id }, "@everyone lunch?", first.entry.id);
    const host = hostedSend(group, { kind: "host" }, "@Wink run the build", second.entry.id);
    expect([first.ask, second.ask, host.ask]).toEqual([null, null, null]);
    expect(recentRoomEntries(group.hosted.roomId, 10).map((entry) => [entry.author.kind, entry.text])).toEqual([
      ["person", "@Wink fix my PC please"],
      ["person", "@everyone lunch?"],
      ["host", "@Wink run the build"],
    ]);
    expect(store.messagesFor(group.threadId).map((message) => message.text)).toEqual(["@Wink fix my PC please", "@everyone lunch?", "@Wink run the build"]);
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ type: "message", threadId: group.threadId })]));
    expect(roomAsks(group.hosted.roomId, ["held", "queued", "running", "stopping", "done", "failed", "cancelled"])).toEqual([]);
    noWork();
  });

  it("wakes no bot even when one is forced onto the roster", () => {
    store.patchGroup(group.id, { memberIds: [wink] });
    const sent = hostedSend(store.group(group.id) as HostedGroup, { kind: "person", id: mina.id }, "@Wink are you there?");
    expect(sent.ask).toBeNull();
    expect(roomAsks(group.hosted.roomId, ["held", "queued", "running"])).toEqual([]);
    noWork();
  });

  it("goes from the host's send route to the log with no runner", () => {
    const spies = { runGroupMemberTurn: vi.fn(), enqueueDrainedRoomTurn: vi.fn(), queueRoomParticipation: vi.fn(), startTurn: vi.fn(), roomSetupPending: vi.fn(() => false) };
    const start = load("startGroupTurn", { store, hostedSend, ...spies });
    expect(start(group.id, "@Wink hi")).toMatchObject({ role: "user", text: "@Wink hi" });
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    noWork();
  });
});

describe("bot work in a people-only room fails closed", () => {
  let group: HostedGroup;
  let entryId: string;

  beforeEach(async () => {
    group = await peopleRoom();
    entryId = appendRoomEntry(group.hosted.roomId, { author: { kind: "host", id: "host", name: "Edward" }, text: "@Wink go" }).id;
    store.patchGroup(group.id, { memberIds: [wink] });
    group = store.group(group.id) as HostedGroup;
  });

  it("at admission: no ask row, no admit, no run", () => {
    expect(() => createAsk({ roomId: group.hosted.roomId, threadId: group.threadId, botId: wink, asker: { kind: "host", id: "host" }, entryId, grant: "work", clean: true }))
      .toThrow(expect.objectContaining({ status: 409 }));
    const held = forgedAsk(group, "held", entryId);
    admitAsk(held, "work");
    expect(askById(held)!.state).toBe("failed");
    const queued = forgedAsk(group, "queued", entryId);
    runAsk(askById(queued)!);
    expect(askById(queued)!.state).toBe("failed");
    expect(recentRoomEntries(group.hosted.roomId, 10).filter((entry) => entry.author.kind === "bot")).toEqual([]);
    noWork();
  });

  it("at final dispatch: a stale ask never starts or gets a native step", () => {
    const queued = forgedAsk(group, "queued", entryId);
    expect(startAsk(queued)).toBe(false);
    expect(askById(queued)!.state).toBe("failed");
    const running = forgedAsk(group, "running", entryId);
    expect(askAllowsRequest(running)).toBe(false);
    expect(hostedTurnRefused(group as GroupRecord, group.threadId, wink, running)).toBe(true);
    expect(recentRoomEntries(group.hosted.roomId, 10).filter((entry) => entry.author.kind === "bot")).toEqual([]);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(Object.values(engine).every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  const SHAPES: Array<[string, unknown[]]> = [
    ["routine", [0, new Set(), "routine line", vi.fn(), () => false, undefined, new Set(["card"]), null]],
    ["task resume", [0, new Set(), "Continue the task", vi.fn(), () => false, undefined, undefined, null]],
    ["continuation", [0, new Set(), "Wink connection update", vi.fn(), () => false, undefined, undefined, null]],
  ];

  it.each(SHAPES)("refuses a %s, even carrying a stale ask, with 0 model calls", async (_name, args) => {
    const stale = forgedAsk(group, "queued", entryId);
    const runners = {
      botHasActiveTurn: vi.fn(() => false),
      tryClaimTurnStart: vi.fn(() => true),
      queueBusyRoomMember: vi.fn(() => true),
      runClaimedGroupMemberTurn: vi.fn(async () => true),
      resolvedBotSelection: vi.fn(),
      takeStartingHold: vi.fn(() => () => {}),
      beginGroupTurnOperation: vi.fn(),
    };
    const cfg = { profile: {} };
    const run = load("runGroupMemberTurn", { ...runners, store, cfg, hostedTurnRefused, continueQueuedDrainIfIdle: vi.fn(), drainQueuedSends: vi.fn(), paneWake: {}, turnStartClaims: new Map() });
    expect(await run(group.id, group.threadId, wink, ...args, stale)).toBe(false);
    for (const spy of Object.values(runners)) expect(spy).not.toHaveBeenCalled();
    noWork();
  });

  it("drops stale queued work at the drain before a queue slot", async () => {
    const stale = forgedAsk(group, "queued", entryId);
    const failed = vi.fn();
    const beginGroupTurnOperation = vi.fn(() => ({ cancelled: false }));
    const runGroupMemberTurn = vi.fn();
    const drain = load("enqueueDrainedRoomTurn", {
      store, hostedTurnRefused, roomTurnStillAssigned: () => true, beginGroupTurnOperation, groupQueues: new Map(), runGroupMemberTurn,
      finishGroupTurnOperation: vi.fn(), writeChatError: () => false, terminalBridgeAccess: null,
    });
    await drain(wink, group.threadId, { groupId: group.id, hop: 0, askId: stale, onDispatchError: failed });
    expect(failed).toHaveBeenCalledTimes(1);
    expect([beginGroupTurnOperation, runGroupMemberTurn].map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    noWork();
  });
});
