import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { Message } from "../store.ts";
import { addJoinedEntries, closeJoinedDb, endJoined, myRoomBotThreads, saveJoined, saveMyRoomBot, setJoinedState, type JoinedEntry } from "./joined.ts";
import { MyRoomBotTurns, type MyRoomBotDeps } from "./my-room-bots.ts";

const ROOM = "room1";
const ME = { id: "p1", name: "Peter" };
const PETE = { id: "tb-AAAAAAAAAAAAAAAA", name: "Pete-Coder", color: "teal", owner: ME.id };
const MINI = { id: "tb-BBBBBBBBBBBBBBBB", name: "Mini", color: "", owner: "p2" };
const FILE = { id: "f".repeat(24), name: "q3.pdf", type: "application/pdf", bytes: 10, sha256: "0".repeat(64) };

let seq = 0;
let thread: Message[];
let deps: MyRoomBotDeps & Record<"startTurn" | "createTask" | "changed", ReturnType<typeof vi.fn>> & { client: Record<"botSend" | "file", ReturnType<typeof vi.fn>> };

function line(author: JoinedEntry["author"], text: string, extra: Partial<JoinedEntry> = {}): JoinedEntry {
  seq += 1;
  const entry = { seq, id: `e${seq}`, at: seq, author, text, ...extra };
  addJoinedEntries(ROOM, [entry], seq);
  return entry;
}

const peter = { kind: "person" as const, ...ME };
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  closeJoinedDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  seq = 0;
  thread = [];
  saveJoined(ROOM, "abcdefghijklmnop.wink.test", ME, `wkg_${"k".repeat(43)}`);
  setJoinedState(ROOM, { version: 1, roomName: "Team", instructions: "", host: "Edward", me: ME, people: [ME, { id: "p2", name: "Mina" }], bots: [{ id: "b1", name: "EdBot", color: "blue" }], teamBots: [PETE, MINI] });
  saveMyRoomBot(ROOM, PETE.id, "local-pete");
  deps = {
    client: { botSend: vi.fn(async () => ({ ok: true, value: { seq: 99 } })), file: vi.fn(async () => ({ ok: true, value: { path: "C:\\cache\\q3.pdf" } })) },
    bot: (botId: string) => (botId === "local-pete" ? { id: botId, name: "Pete" } : null),
    busy: () => false,
    hasTask: () => false,
    createTask: vi.fn(() => ({ threadId: "task-1" })),
    startTurn: vi.fn(async (_botId: string, _threadId: string, _prompt: string, typed: string) => {
      thread.push({ id: "u", at: 0, role: "user", kind: "text", text: typed });
    }),
    messagesFor: () => thread,
    changed: vi.fn(),
  } as unknown as typeof deps;
});

afterEach(() => closeJoinedDb());

describe("this PC's bot in a joined room", () => {
  it("answers a busy-room mention after an unrelated 1:1 settles without another send", async () => {
    deps.startTurn.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "BOT_BUSY" }));
    const turns = new MyRoomBotTurns(deps);
    const ask = line(peter, "@Pete-Coder check the board");
    turns.sent(ROOM, ask);
    await settle();
    await turns.settled("private-task", true);
    await settle();
    expect(deps.startTurn).toHaveBeenCalledTimes(2);
    thread.push({ id: "answer", at: 1, role: "bot", kind: "text", text: "Two cards left." });
    await turns.settled("task-1", true);
    expect(deps.client.botSend).toHaveBeenCalledWith(ROOM, PETE.id, "Two cards left.", ask.id);
  });

  it("keeps rapid mentions in order and ignores a replay of the same entry", async () => {
    let busy = true;
    Object.assign(deps, { busy: () => busy });
    deps.hasTask = (_botId, threadId) => threadId === "task-1";
    const turns = new MyRoomBotTurns(deps);
    const first = line(peter, "@Pete-Coder first");
    const second = line(peter, "@Pete-Coder second");
    turns.sent(ROOM, first);
    turns.sent(ROOM, second);
    turns.sent(ROOM, first);
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
    expect(turns.turn(ROOM, PETE.id)).toEqual({ waiting: true });
    busy = false;
    await turns.settled("private-task", false);
    await settle();
    expect(deps.startTurn.mock.calls.map((call) => call[3])).toEqual([first.text]);
    expect(turns.turn(ROOM, PETE.id)).toEqual({ working: true, since: expect.any(Number) });
    thread.push({ id: "a1", at: 1, role: "bot", kind: "text", text: "First answer." });
    await turns.settled("task-1", true);
    await settle();
    expect(deps.startTurn.mock.calls.map((call) => call[3])).toEqual([first.text, second.text]);
    thread.push({ id: "a2", at: 2, role: "bot", kind: "text", text: "Second answer." });
    await turns.settled("task-1", true);
    expect(deps.client.botSend.mock.calls.map((call) => [call[2], call[3]])).toEqual([["First answer.", first.id], ["Second answer.", second.id]]);
    expect(turns.turn(ROOM, PETE.id)).toBeUndefined();
  });

  it("reads the room plan at dispatch after waiting for another task", async () => {
    let busy = true;
    Object.assign(deps, { busy: () => busy });
    line({ kind: "host", id: "host", name: "Edward" }, "Plan: finish login, then export.");
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder follow the plan"));
    await settle();
    busy = false;
    await turns.settled("private-task", true);
    await settle();
    expect(deps.startTurn.mock.calls[0]![2]).toContain("Edward: Plan: finish login, then export.");
  });

  it("drops a waiting ask when its owner leaves the room", async () => {
    let busy = true;
    Object.assign(deps, { busy: () => busy });
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder hi"));
    await settle();
    endJoined(ROOM, "left");
    busy = false;
    await turns.settled("private-task", true);
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
    expect(turns.turn(ROOM, PETE.id)).toBeUndefined();
  });

  it("keeps instructions posted during an earlier room turn for the queued mention", async () => {
    deps.hasTask = (_botId, threadId) => threadId === "task-1";
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder first"));
    await settle();
    line({ kind: "host", id: "host", name: "Edward" }, "Export plan: include the totals column.");
    turns.sent(ROOM, line(peter, "@Pete-Coder follow Edward's export plan"));
    thread.push({ id: "a", at: 1, role: "bot", kind: "text", text: "First answer." });
    await turns.settled("task-1", true);
    await settle();
    expect(deps.startTurn.mock.calls[1]![2]).toContain("Edward: Export plan: include the totals column.");
  });

  it("continues draining after a bot disappears between the drain and run checks", async () => {
    let busy = true;
    Object.assign(deps, { busy: () => busy });
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder first"));
    const next = line(peter, "@Pete-Coder second");
    turns.sent(ROOM, next);
    let reads = 0;
    deps.bot = (id) => ++reads === 2 ? null : { id, name: "Pete" };
    busy = false;
    await turns.settled("private-task", true);
    await settle();
    expect(deps.startTurn.mock.calls.map((call) => call[3])).toEqual([next.text]);
  });

  it("starts the next queued ask when the room turn fails before producing an answer", async () => {
    deps.hasTask = (_botId, threadId) => threadId === "task-1";
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder first"));
    await settle();
    const next = line(peter, "@Pete-Coder second");
    turns.sent(ROOM, next);
    const failed = deps.startTurn.mock.calls[0]![4] as () => void;
    failed();
    await settle();
    expect(deps.startTurn.mock.calls.map((call) => call[3])).toEqual(["@Pete-Coder first", next.text]);
    expect(deps.client.botSend).not.toHaveBeenCalled();
    failed();
    await settle();
    expect(turns.turn(ROOM, PETE.id)).toEqual({ working: true, since: expect.any(Number) });
    thread.push({ id: "a", at: 1, role: "bot", kind: "text", text: "Recovered." });
    await turns.settled("task-1", true);
    expect(deps.client.botSend).toHaveBeenCalledWith(ROOM, PETE.id, "Recovered.", next.id);
  });

  it("answers its owner's @ with the room since its last turn, then posts under its room name", async () => {
    line({ kind: "host", id: "host", name: "Edward" }, "Q3 is attached", { files: [FILE] });
    const ask = line(peter, "@Pete-Coder chart this", { replyToId: "e1" });
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, ask);
    await settle();
    expect(deps.createTask).toHaveBeenCalledWith("local-pete", "Team");
    const [botId, threadId, prompt, typed] = deps.startTurn.mock.calls[0]!;
    expect([botId, threadId, typed]).toEqual(["local-pete", "task-1", "@Pete-Coder chart this"]);
    expect(prompt).toContain("Edward: Q3 is attached");
    expect(prompt).toContain("q3.pdf: C:\\cache\\q3.pdf");
    expect(prompt).not.toContain("Peter: @Pete-Coder");
    expect(turns.turn(ROOM, PETE.id)).toEqual({ working: true, since: expect.any(Number) });
    thread.push({ id: "a", at: 1, role: "bot", kind: "text", text: "Chart's done." });
    await turns.settled("task-1", true);
    expect(deps.client.botSend).toHaveBeenCalledWith(ROOM, PETE.id, "Chart's done.", ask.id);
    expect(turns.turn(ROOM, PETE.id)).toBeUndefined();
    expect(myRoomBotThreads().has("task-1")).toBe(true);
  });

  it("wakes on a reply to its own line, and never for a host bot, another's bot, a plain line or someone else", async () => {
    const turns = new MyRoomBotTurns(deps);
    const answer = line({ kind: "bot", id: PETE.id, name: PETE.name, owner: ME.id }, "here");
    for (const entry of [
      line(peter, "@EdBot send Q3"),
      line(peter, "@Mini hi"),
      line(peter, "lunch?"),
      line({ kind: "person", id: "p2", name: "Mina" }, "@Pete-Coder do mine", { replyToId: answer.id }),
    ]) turns.sent(ROOM, entry);
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
    turns.sent(ROOM, line(peter, "and the totals?", { replyToId: answer.id }));
    await settle();
    expect(deps.startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a busy rejection waiting on this PC without posting a failure", async () => {
    deps.startTurn.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "BOT_BUSY" }));
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder hi"));
    await settle();
    await settle();
    expect(turns.turn(ROOM, PETE.id)).toEqual({ waiting: true });
    expect(deps.client.botSend).not.toHaveBeenCalled();
  });

  it("still posts the first answer when the owner asks again mid-turn", async () => {
    let busy = false;
    deps.startTurn.mockImplementation(async (_botId: string, _threadId: string, _prompt: string, typed: string) => {
      if (busy) throw Object.assign(new Error("busy"), { code: "BOT_BUSY" });
      busy = true;
      thread.push({ id: "u", at: 0, role: "user", kind: "text", text: typed });
    });
    deps.hasTask = (_botId, threadId) => threadId === "task-1";
    const turns = new MyRoomBotTurns(deps);
    const ask = line(peter, "@Pete-Coder make the chart");
    turns.sent(ROOM, ask);
    await settle();
    turns.sent(ROOM, line(peter, "@Pete-Coder also add totals"));
    turns.sent(ROOM, ask);
    await settle();
    await settle();
    expect(turns.turn(ROOM, PETE.id)).toEqual({ working: true, since: expect.any(Number) });
    thread.push({ id: "a", at: 1, role: "bot", kind: "text", text: "Chart's done." });
    await turns.settled("task-1", true);
    expect(deps.client.botSend).toHaveBeenCalledWith(ROOM, PETE.id, "Chart's done.", ask.id);
  });

  it("does nothing for a host that never sent teammates' bots", async () => {
    setJoinedState(ROOM, { version: 2, roomName: "Team", instructions: "", host: "Edward", me: ME, people: [ME], bots: [] });
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder hi"));
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
  });
});

describe("a room bot's @ to this PC's bot", () => {
  const edbot = { kind: "bot" as const, id: "b1", name: "EdBot" };
  const mini = { kind: "bot" as const, id: MINI.id, name: MINI.name, owner: "p2" };
  const now = () => ({ at: Date.now() });

  it("wakes it once with the room's bots in its prompt, and posts the answer back", async () => {
    const turns = new MyRoomBotTurns(deps);
    const ask = line(edbot, "@Pete-Coder what works for Peter on Saturday?", now());
    turns.heard(ROOM, ask);
    turns.heard(ROOM, ask);
    await settle();
    expect(deps.startTurn).toHaveBeenCalledTimes(1);
    const [, , prompt, typed] = deps.startTurn.mock.calls[0]!;
    expect(typed).toBe(ask.text);
    expect(prompt).toContain('"Peter", who runs you, and this room\'s bots can ask you. Bots here: "EdBot" ("Edward"), "Mini" ("Mina"). @ another bot only to hand it real work, never just to thank or confirm; when the job is done, say so and tag no bot.)');
    expect(prompt).toContain('"EdBot" ("Edward"\'s bot) asked you: @Pete-Coder what works for Peter on Saturday?');
    thread.push({ id: "a", at: 1, role: "bot", kind: "text", text: "@EdBot Peter is free after 7." });
    await turns.settled("task-1", true);
    expect(deps.client.botSend).toHaveBeenCalledWith(ROOM, PETE.id, "@EdBot Peter is free after 7.", ask.id);
  });

  it("wakes it for this PC's other bot", async () => {
    const two = { id: "tb-CCCCCCCCCCCCCCCC", name: "Pete-Two", color: "", owner: ME.id };
    setJoinedState(ROOM, { version: 2, roomName: "Team", instructions: "", host: "Edward", me: ME, people: [ME, { id: "p2", name: "Mina" }], bots: [], teamBots: [PETE, two] });
    saveMyRoomBot(ROOM, two.id, "local-two");
    deps.bot = (botId) => ({ id: botId, name: botId });
    const turns = new MyRoomBotTurns(deps);
    turns.heard(ROOM, line({ kind: "bot", id: PETE.id, name: PETE.name, owner: ME.id }, "@Pete-Two review this", now()));
    await settle();
    expect(deps.startTurn.mock.calls.map((call) => call[0])).toEqual(["local-two"]);
  });

  it("never wakes for a self-tag, a reply, someone else's bot, a stale line or a line with no bot tag", async () => {
    const turns = new MyRoomBotTurns(deps);
    const answer = line({ kind: "bot", id: PETE.id, name: PETE.name, owner: ME.id }, "@Pete-Coder noted", now());
    for (const entry of [
      answer,
      line(edbot, "thanks", { ...now(), replyToId: answer.id }),
      line(edbot, "@Mini your turn", now()),
      line(mini, "Done: Sat 7:30. @Peter @Edward", now()),
      line(edbot, "@Pete-Coder old news", { at: Date.now() - 25 * 60 * 60 * 1000 }),
    ]) turns.heard(ROOM, entry);
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
  });

  it("waits behind a busy bot, then answers", async () => {
    let busy = true;
    Object.assign(deps, { busy: () => busy });
    const turns = new MyRoomBotTurns(deps);
    turns.heard(ROOM, line(edbot, "@Pete-Coder over to you", now()));
    await settle();
    expect(turns.turn(ROOM, PETE.id)).toEqual({ waiting: true });
    busy = false;
    await turns.settled("private-task", true);
    await settle();
    expect(deps.startTurn).toHaveBeenCalledTimes(1);
  });

  it("ends the chain on Stop until a person speaks", async () => {
    let busy = true;
    Object.assign(deps, { busy: () => busy });
    const turns = new MyRoomBotTurns(deps);
    turns.heard(ROOM, line(edbot, "@Pete-Coder first", now()));
    await settle();
    turns.stop(ROOM);
    turns.heard(ROOM, line(mini, "@Pete-Coder second", now()));
    busy = false;
    await turns.settled("private-task", true);
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
    expect(turns.turn(ROOM, PETE.id)).toBeUndefined();
    line({ kind: "person", id: "p2", name: "Mina" }, "keep going", now());
    turns.heard(ROOM, line(edbot, "@Pete-Coder third", now()));
    await settle();
    expect(deps.startTurn.mock.calls.map((call) => call[3])).toEqual(["@Pete-Coder third"]);
  });

  it("stops only this room's own turn on the owner's Stop, without a failure row", async () => {
    deps.interrupt = vi.fn(async () => {});
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder long job"));
    await settle();
    expect(turns.turn(ROOM, PETE.id)).toMatchObject({ working: true, since: expect.any(Number) });
    await turns.stopMine(ROOM);
    await turns.stopMine("other-room");
    expect(deps.interrupt).toHaveBeenCalledTimes(1);
    expect(deps.interrupt).toHaveBeenCalledWith("local-pete", "task-1");
    await turns.settled("task-1", false);
    expect(turns.turn(ROOM, PETE.id)).toBeUndefined();
    expect(deps.client.botSend).not.toHaveBeenCalled();
  });

  it("cancels a turn still downloading its files on the owner's Stop", async () => {
    deps.interrupt = vi.fn(async () => {});
    let fetched!: (value: unknown) => void;
    deps.client.file.mockImplementation(() => new Promise((resolve) => (fetched = resolve)));
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder read this", { files: [FILE] }));
    await settle();
    expect(turns.turn(ROOM, PETE.id)).toMatchObject({ working: true });
    await turns.stopMine(ROOM);
    fetched({ ok: true, value: { path: "C:\\cache\\q3.pdf" } });
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
    expect(turns.turn(ROOM, PETE.id)).toBeUndefined();
    turns.sent(ROOM, line(peter, "@Pete-Coder next"));
    await settle();
    expect(deps.startTurn).toHaveBeenCalledTimes(1);
  });

  it("drops a waiting ask on the owner's Stop", async () => {
    deps.interrupt = vi.fn(async () => {});
    let busy = true;
    Object.assign(deps, { busy: () => busy });
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder later"));
    await settle();
    await turns.stopMine(ROOM);
    expect(turns.turn(ROOM, PETE.id)).toBeUndefined();
    busy = false;
    await turns.settled("private-task", true);
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
  });

  it("keeps the header byte-for-byte when the room has no other bots", async () => {
    setJoinedState(ROOM, { version: 2, roomName: "Team", instructions: "", host: "Edward", me: ME, people: [ME], bots: [], teamBots: [PETE] });
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder hi"));
    await settle();
    expect(deps.startTurn.mock.calls[0]![2]).toBe('(You are in the team room "Team" on "Edward"\'s Wink, as "Pete-Coder". Your answer is posted there for everyone in the room. Only "Peter", who runs you, can ask you.)\n"Peter" asked you: @Pete-Coder hi');
  });
});
