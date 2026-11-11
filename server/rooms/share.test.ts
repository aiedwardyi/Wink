import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store, type GroupRecord, type Message } from "../store.ts";
import type { HostedGroup } from "./asks.ts";
import { closeRoomsDb, recentRoomEntries } from "./db.ts";
import { hostedRoomView, linkedFilesClosed } from "./guards.ts";
import { closeInvitesDb, roomCode } from "./invites.ts";
import { writeRoomEntry } from "./mirror.ts";
import { createPeopleOnlyRoom, peopleOnlyRoom } from "./people-only.ts";
import { shareGroup, shareRoute, type ShareDeps } from "./share.ts";

const HOST = "abcdefghijklmnop.wink.test";

let store: Store;
let wink: string;
let relay: string | null;
let working: boolean;

const deps = (): ShareDeps => ({ store, hostName: () => "Edward", relayHost: () => relay, groupIsWorking: () => working });

const restart = () => {
  closeInvitesDb();
  closeRoomsDb();
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
};

beforeEach(() => {
  closeInvitesDb();
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  wink = store.patchBot(store.createBot().id, { name: "Wink" })!.id;
  relay = HOST;
  working = false;
});
afterEach(() => {
  closeInvitesDb();
  closeRoomsDb();
});

const crew = () => store.createGroup("Crew", [wink]);
const say = (group: GroupRecord, text: string, extra: Partial<Message> = {}) => store.appendMessage(group.threadId, { role: "user", kind: "text", text, ...extra });
const answer = (group: GroupRecord, text: string, extra: Partial<Message> = {}) =>
  store.appendMessage(group.threadId, { role: "bot", kind: "text", text, from: { botId: wink, name: "Wink", color: "white" }, ...extra });
const rows = (roomId: string) => recentRoomEntries(roomId, 1_000);
const roomCount = () => {
  if (!existsSync(join(DATA_DIR, "rooms.db"))) return 0;
  const db = new DatabaseSync(join(DATA_DIR, "rooms.db"));
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number }).n;
  } finally {
    db.close();
  }
};
const statusOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return [(error as { status?: number }).status, (error as Error).message];
  }
  return null;
};

describe("sharing a bot group", () => {
  it("retries and restarts a seeded share into one room, keeping times and reply mapping", () => {
    const group = crew();
    const ask = say(group, "plan the launch", { at: 1_000 });
    answer(group, "here is the plan", { at: 2_000, replyToId: ask.id });
    const first = shareGroup(deps(), group.id);
    expect(first).toEqual({ roomId: expect.any(String), code: expect.stringMatching(/^wkr1:abcdefghijklmnop\.wink\.test:[\w-]+\.wki_/), carried: 2 });
    const count = store.messagesFor(group.threadId).length;
    expect(shareGroup(deps(), group.id)).toEqual(first);
    // groups.json and the row links never landed, then the PC restarted
    for (const message of store.messagesFor(group.threadId)) store.patchMessage(group.threadId, message.id, { roomEntryId: undefined });
    store.patchGroup(group.id, { hosted: undefined });
    restart();
    expect(shareGroup(deps(), group.id)).toEqual(first);
    restart();
    expect(shareGroup(deps(), group.id)).toEqual(first);
    const entries = rows(first.roomId);
    expect(entries.map((entry) => [entry.author.kind, entry.author.name, entry.text, entry.at])).toEqual([
      ["host", "Edward", "plan the launch", 1_000],
      ["bot", "Wink", "here is the plan", 2_000],
    ]);
    expect(entries[1]!.replyToId).toBe(entries[0]!.id);
    const messages = store.messagesFor(group.threadId);
    expect(messages).toHaveLength(count);
    expect(messages.map((message) => message.roomEntryId)).toEqual(entries.map((entry) => entry.id));
    expect(store.group(group.id)!.hosted).toEqual({ roomId: first.roomId });
    expect(roomCount()).toBe(1);
    expect(peopleOnlyRoom(first.roomId)).toBe(false);
  });

  it("publishes no room or code while phone access is off, a member works, or for a bot-to-bot channel", () => {
    const group = crew();
    say(group, "hello");
    relay = null;
    expect(statusOf(() => shareGroup(deps(), group.id))).toEqual([409, "phone access is off"]);
    relay = HOST;
    working = true;
    expect(statusOf(() => shareGroup(deps(), group.id))?.[0]).toBe(409);
    working = false;
    const other = store.patchBot(store.createBot().id, { name: "Pip" })!.id;
    const dm = store.createGroup("Wink & Pip", [wink, other], true);
    expect(statusOf(() => shareGroup(deps(), dm.id))?.[0]).toBe(400);
    expect(statusOf(() => shareGroup(deps(), "nope"))?.[0]).toBe(404);
    expect(roomCount()).toBe(0);
    expect(store.group(group.id)!.hosted).toBeUndefined();
    expect(shareGroup(deps(), group.id).carried).toBe(1);
  });

  it("carries only settled visible text, with attachment tags removed whole", () => {
    const group = crew();
    say(group, 'see this\n\n<attached-file path="C:/PRIVATE/report.txt" name="report.txt" size="9" />');
    answer(group, 'done <attached-image path="C:/PRIVATE/shot.png" />');
    answer(group, "engine summary", { summarized: true });
    store.appendMessage(group.threadId, { role: "bot", kind: "activity", tool: { name: "Read", ok: true }, from: { botId: wink, name: "Wink", color: "white" } });
    say(group, "still waiting", { queued: true });
    say(group, "quick one", { quick: { state: "asked" } });
    say(group, "a routine's prompt", { origin: "routine" });
    answer(group, '<attached-file path="C:/PRIVATE/only.txt" name="only.txt" size="1" />');
    answer(group, "to Pip", { comm: { groupId: "g", withBotId: "b", withName: "Pip", withColor: "white", peer: "message" } });
    const old = say(group, "old version");
    store.branchMessage(group.threadId, old.id, "new version");
    const { roomId } = shareGroup(deps(), group.id);
    expect(rows(roomId).map((entry) => entry.text)).toEqual(["see this", "done", "new version"]);
    expect(JSON.stringify(rows(roomId))).not.toContain("PRIVATE");
  });

  it("carries the active task's last 200 lines, at the room's text caps", () => {
    const group = crew();
    say(group, "the other task");
    store.createGroupTask(group.id);
    const active = store.group(group.id)!;
    for (let i = 0; i < 205; i += 1) {
      const text = i === 10 ? "h".repeat(5_000) : i === 11 ? "b".repeat(25_000) : `line ${i}`;
      if (i % 2) answer(active, text);
      else say(active, text);
    }
    const shared = shareGroup(deps(), group.id);
    const entries = rows(shared.roomId);
    expect(shared.carried).toBe(200);
    expect(entries).toHaveLength(200);
    expect(entries[0]!.text).toBe("line 5");
    expect(entries.find((entry) => entry.text.startsWith("h"))!.text).toHaveLength(4_000);
    expect(entries.find((entry) => entry.text.startsWith("b"))!.text).toHaveLength(20_000);
    expect(entries.some((entry) => entry.text === "the other task")).toBe(false);
  });

  it("gives an existing team room its one code without importing again", () => {
    const group = store.createGroup("Team", [], false, undefined, undefined, { roomId: createPeopleOnlyRoom("Team").id }) as HostedGroup;
    writeRoomEntry(store, group, { author: { kind: "host", id: "host", name: "Edward" }, text: "hello team" });
    const shared = shareGroup(deps(), group.id);
    const code = roomCode(group.hosted.roomId);
    expect(shared).toEqual({ roomId: group.hosted.roomId, code: `wkr1:${HOST}:${code.id}.${code.secret}`, carried: 0 });
    expect(rows(group.hosted.roomId)).toHaveLength(1);
    expect(store.messagesFor(group.threadId)).toHaveLength(1);
    expect(peopleOnlyRoom(group.hosted.roomId)).toBe(true);
  });

  it("re-shares a team room lost with rooms.db as people-only, keeping who said what", () => {
    const group = store.createGroup("Team", [], false, undefined, undefined, { roomId: createPeopleOnlyRoom("Team").id }) as HostedGroup;
    writeRoomEntry(store, group, { author: { kind: "host", id: "host", name: "Edward" }, text: "hello team" });
    writeRoomEntry(store, group, { author: { kind: "person", id: "p1", name: "Mina" }, text: "hi Edward" });
    const before = store.messagesFor(group.threadId).map((message) => [message.id, message.at]);
    const lost = group.hosted.roomId;
    closeInvitesDb();
    closeRoomsDb();
    for (const file of ["rooms.db", "rooms.db-wal", "rooms.db-shm"]) rmSync(join(DATA_DIR, file), { force: true });
    expect(hostedRoomView(group.hosted)).toEqual({ missing: true });
    const shared = shareGroup(deps(), group.id);
    expect(shared.roomId).not.toBe(lost);
    expect(peopleOnlyRoom(shared.roomId)).toBe(true);
    const entries = rows(shared.roomId);
    expect(entries.map((entry) => [entry.author.kind, entry.author.id, entry.author.name, entry.text])).toEqual([
      ["host", "host", "Edward", "hello team"],
      ["person", "p1", "Mina", "hi Edward"],
    ]);
    const messages = store.messagesFor(group.threadId);
    expect(messages.map((message) => [message.id, message.at])).toEqual(before);
    expect(entries.map((entry) => entry.at)).toEqual(before.map(([, at]) => at));
    expect(messages.map((message) => message.roomEntryId)).toEqual(entries.map((entry) => entry.id));
    expect(store.group(group.id)!.hosted).toEqual({ roomId: shared.roomId });
  });

  it("keeps the owner's file links on old tasks, not on the shared one", () => {
    const group = crew();
    const old = group.threadId;
    store.createGroupTask(group.id);
    expect(linkedFilesClosed(store.group(group.id)!, old)).toBe(false);
    shareGroup(deps(), group.id);
    const shared = store.group(group.id)!;
    expect(linkedFilesClosed(shared, old)).toBe(false);
    expect(linkedFilesClosed(shared, shared.threadId)).toBe(true);
  });
});

describe("the share route", () => {
  async function post(path: string, botCaller = false, method = "POST") {
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const handled = await shareRoute({} as IncomingMessage, res as unknown as ServerResponse, method, path, { ...deps(), botCaller, publicGroupState: (group) => ({ id: group.id, hosted: group.hosted }) });
    return handled ? { status: res.writeHead.mock.calls[0]![0] as number, body: JSON.parse(res.end.mock.calls[0]![0]) } : null;
  }

  it("shares for the owner only, and leaves other paths alone", async () => {
    const group = crew();
    say(group, "hello");
    expect(await post(`/api/groups/${group.id}/share`, true)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect((await post(`/api/groups/${group.id}/share`, false, "GET"))?.status).toBe(404);
    expect(await post(`/api/groups/${group.id}/sharex`)).toBeNull();
    const shared = await post(`/api/groups/${group.id}/share`);
    expect(shared).toEqual({ status: 200, body: { roomId: expect.any(String), code: expect.any(String), carried: 1, group: { id: group.id, hosted: { roomId: shared!.body.roomId } } } });
    relay = null;
    expect(await post(`/api/groups/${group.id}/share`)).toEqual({ status: 409, body: { error: "phone access is off" } });
  });
});
