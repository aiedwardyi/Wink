import { readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DATA_DIR } from "../config.ts";
import { _resetSteerQueue, drainSteeredMessages, queueRoomParticipation, type RoomDrain } from "../steer-queue.ts";
import { Store } from "../store.ts";
import { askById, closeAsksDb, configureRoomAsks, hostedTurnRefused, roomAsks, startAsk, type HostedGroup, type RoomAsk, type RoomAskDeps } from "./asks.ts";
import { addPerson, closeRoomsDb, createRoom, recentRoomEntries, type RoomPerson } from "./db.ts";
import { goLive, openDoorStream } from "./door-streams.ts";
import { askNote, publishTurnAnswer } from "./multiplayer.ts";
import { hostedSend } from "./send.ts";

const index = ts.createSourceFile("index.ts", readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
const js = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(node).toBeDefined();
  return new Function(...Object.keys(deps), `${js(node!.getText(index))}\nreturn ${name};`)(...Object.values(deps));
}

/** What a guest from before bots in rooms accepts for an entry. */
const oldEntry = z.object({
  seq: z.number().int().positive(),
  id: z.string().regex(/^[\w-]{1,64}$/),
  at: z.number(),
  author: z.object({ kind: z.enum(["host", "person"]), id: z.string().regex(/^[\w-]{1,64}$/), name: z.string().max(200) }),
  text: z.string().max(20_000),
  replyToId: z.string().optional(),
});

let store: Store;
let group: HostedGroup;
let wink: string;
let sora: RoomPerson;
let deps: RoomAskDeps;

const asks = () => roomAsks(group.hosted.roomId, ["held", "queued", "running", "stopping", "done", "failed", "cancelled"]);
const said = (who: RoomPerson) => ({ kind: "person" as const, id: who.id });
const botEntries = () => recentRoomEntries(group.hosted.roomId, 50).filter((entry) => entry.author.kind === "bot");
const botRow = (text: string, patch: Record<string, unknown> = {}) =>
  store.appendMessage(group.threadId, { role: "bot", kind: "text", text, from: { botId: wink, name: "Wink", color: "blue" }, ...patch });

beforeEach(() => {
  closeRoomsDb();
  closeAsksDb();
  _resetSteerQueue();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  wink = store.patchBot(store.createBot().id, { name: "Wink", color: "blue" })!.id;
  group = store.createGroup("Crew", [wink], false, undefined, undefined, { roomId: createRoom("Crew").id }) as HostedGroup;
  sora = addPerson(group.hosted.roomId, "Sora", "chat", ["Wink"]);
  deps = {
    store,
    hostName: () => "Edward",
    instance: () => null,
    dispatch: vi.fn(),
    stopTurn: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
  };
  configureRoomAsks(deps);
});
afterEach(() => {
  configureRoomAsks(null);
  closeAsksDb();
  closeRoomsDb();
});

describe("a teammate's line in a shared bot group", () => {
  it("makes a new chat-level member's @ one work ask on the room queue, on any engine", () => {
    const sent = hostedSend(group, said(sora), "@Wink what's left?");
    expect(sent.ask).toMatchObject({ botId: wink, grant: "work", state: "queued", asker: { kind: "person", id: sora.id }, entryId: sent.entry.id });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect((deps.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ id: sent.ask!.id });
  });

  it("wakes the only bot on a plain line, never on a line to a person", () => {
    expect(hostedSend(group, said(sora), "what's left?").ask).toMatchObject({ botId: wink });
    addPerson(group.hosted.roomId, "Mina", "chat", ["Wink"]);
    expect(hostedSend(group, said(sora), "@Mina lunch?").ask).toBeNull();
    expect(hostedSend(group, said(sora), "@everyone lunch?").ask).toBeNull();
  });

  it("wakes nobody on a plain line once the group has two bots", () => {
    const pip = store.patchBot(store.createBot().id, { name: "Pip" })!.id;
    store.patchGroup(group.id, { memberIds: [wink, pip] });
    expect(hostedSend(store.group(group.id) as HostedGroup, said(sora), "what's left?").ask).toBeNull();
    expect(hostedSend(store.group(group.id) as HostedGroup, said(sora), "@Pip what's left?").ask).toMatchObject({ botId: pip });
  });

  it("commits the host's own line with no ask, for the normal group turn to answer", () => {
    const sent = hostedSend(group, { kind: "host" }, "@Wink hi");
    expect(sent.ask).toBeNull();
    expect(sent.entry.author).toEqual({ kind: "host", id: "host", name: "Edward" });
    expect(sent.message).toMatchObject({ role: "user", roomEntryId: sent.entry.id });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("lets the host's own turns, chains and resumes run on the shared thread, not on an older task", () => {
    expect(hostedTurnRefused(group, group.threadId, wink)).toBe(false);
    expect(hostedTurnRefused(group, "an-older-task", wink)).toBe(true);
  });

  it("names who asked and what, for the bot that answers", () => {
    const { ask } = hostedSend(group, said(sora), "@Wink 남은 거 정리해 줘");
    expect(askNote(ask!.id, "Wink")).toBe('(Sora asked you: "@Wink 남은 거 정리해 줘". Reply to them as Wink.)');
    expect(askNote(undefined, "Wink")).toBe("(Reply to the conversation above as Wink.)");
  });
});

describe("the answer", () => {
  /** The real busy path: runGroupMemberTurn sees a working bot and parks the ask on its queue. */
  async function queuedBehindBusyBot(ask: RoomAsk): Promise<RoomDrain> {
    const queueBusyRoomMember = load("queueBusyRoomMember", { queueRoomParticipation });
    const run = load("runGroupMemberTurn", {
      store, cfg: { profile: {} }, hostedTurnRefused, botHasActiveTurn: () => true, tryClaimTurnStart: vi.fn(), queueBusyRoomMember,
      runClaimedGroupMemberTurn: vi.fn(), takeStartingHold: vi.fn(), turnStartClaims: new Map(), continueQueuedDrainIfIdle: vi.fn(), drainQueuedSends: vi.fn(), paneWake: {},
    });
    expect(await run(group.id, group.threadId, wink, 0, new Set(), undefined, vi.fn(), () => false, undefined, undefined, null, ask.id)).toBe(true);
    const drained: RoomDrain[] = [];
    drainSteeredMessages({ bot: (id: string) => store.bot(id), messagesFor: () => [], appendMessage: vi.fn(), patchMessage: vi.fn() } as never, (_bot, _thread, _prompt, _user, _ex, room) => { drained.push(room!); });
    expect(drained).toHaveLength(1);
    return drained[0]!;
  }

  function viewer(bots: boolean) {
    const res = new PassThrough();
    let text = "";
    res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    goLive(openDoorStream(group.hosted.roomId, sora.id, res as unknown as ServerResponse, bots), 0);
    return () => text.split("\n\n").filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice(6)) as { kind: string; entry?: { author: unknown; text: string } });
  }

  it("runs a chat-level member's @ through the busy queue to one attributed answer and a done ask", async () => {
    const old = viewer(false);
    const fresh = viewer(true);
    const { ask, entry } = hostedSend(group, said(sora), "@Wink what's left?");
    const drain = await queuedBehindBusyBot(ask!);
    expect(drain.askId).toBe(ask!.id);
    expect(startAsk(ask!.id)).toBe(true);
    const since = store.messagesFor(group.threadId).length;
    botRow("Checking the board.", { summarized: true });
    const final = botRow("Two cards left: login and export.");
    const rows = store.messagesFor(group.threadId).length;
    publishTurnAnswer(store, group, group.threadId, store.bot(wink)!, since, ask!.id);
    expect(botEntries()).toEqual([expect.objectContaining({ author: { kind: "bot", id: wink, name: "Wink" }, text: "Two cards left: login and export.", replyToId: entry.id, askId: ask!.id })]);
    expect(askById(ask!.id)!.state).toBe("done");
    expect(store.messagesFor(group.threadId)).toHaveLength(rows);
    expect(store.messagesFor(group.threadId).find((row) => row.id === final.id)!.roomEntryId).toBe(botEntries()[0]!.id);
    const answerOf = (frames: ReturnType<ReturnType<typeof viewer>>) => frames.filter((frame) => frame.kind === "entry").at(-1)!.entry!;
    expect(answerOf(fresh()).author).toEqual({ kind: "bot", id: wink, name: "Wink" });
    expect(answerOf(old()).author).toEqual({ kind: "person", id: `bot-${wink}`, name: "Wink" });
    expect(old().filter((frame) => frame.kind === "entry").every((frame) => oldEntry.safeParse(frame.entry).success)).toBe(true);
  });

  it("answers the host's own turn with a bot line and no reply link", () => {
    hostedSend(group, { kind: "host" }, "@Wink hi");
    const since = store.messagesFor(group.threadId).length;
    botRow("Hi Edward.");
    publishTurnAnswer(store, group, group.threadId, store.bot(wink)!, since);
    expect(botEntries()).toEqual([expect.objectContaining({ author: { kind: "bot", id: wink, name: "Wink" }, text: "Hi Edward." })]);
    expect(botEntries()[0]!.replyToId).toBeUndefined();
  });

  it("ends an ask whose turn showed nothing as failed, with its line", () => {
    const { ask } = hostedSend(group, said(sora), "@Wink hi");
    expect(startAsk(ask!.id)).toBe(true);
    publishTurnAnswer(store, group, group.threadId, store.bot(wink)!, store.messagesFor(group.threadId).length, ask!.id);
    return vi.waitFor(() => {
      expect(askById(ask!.id)!.state).toBe("failed");
      expect(botEntries().map((row) => row.text)).toEqual(["Wink couldn't finish this."]);
    });
  });

  it("leaves a stopped ask's own end line and posts no answer", () => {
    const { ask } = hostedSend(group, said(sora), "@Wink hi");
    expect(startAsk(ask!.id)).toBe(true);
    closeAsksDb();
    const since = store.messagesFor(group.threadId).length;
    botRow("half an answer");
    // A room Stop took the ask to stopping while the turn was settling.
    const raw = new DatabaseSync(join(DATA_DIR, "rooms.db"));
    raw.prepare("UPDATE asks SET state = 'stopping' WHERE id = ?").run(ask!.id);
    raw.close();
    publishTurnAnswer(store, group, group.threadId, store.bot(wink)!, since, ask!.id);
    expect(botEntries()).toEqual([]);
    expect(asks().map((row) => row.state)).toEqual(["stopping"]);
  });
});
