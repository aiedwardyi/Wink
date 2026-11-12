import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { Message } from "../store.ts";
import { addJoinedEntries, closeJoinedDb, myRoomBotThreads, saveJoined, saveMyRoomBot, setJoinedState, type JoinedEntry } from "./joined.ts";
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
    expect(turns.turn(ROOM, PETE.id)).toEqual({ working: true });
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

  it("shows busy on this PC only and posts nothing", async () => {
    deps.startTurn.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "BOT_BUSY" }));
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder hi"));
    await settle();
    await settle();
    expect(turns.turn(ROOM, PETE.id)).toEqual({ error: "busy" });
    expect(deps.client.botSend).not.toHaveBeenCalled();
  });

  it("does nothing for a host that never sent teammates' bots", async () => {
    setJoinedState(ROOM, { version: 2, roomName: "Team", instructions: "", host: "Edward", me: ME, people: [ME], bots: [] });
    const turns = new MyRoomBotTurns(deps);
    turns.sent(ROOM, line(peter, "@Pete-Coder hi"));
    await settle();
    expect(deps.startTurn).not.toHaveBeenCalled();
  });
});
