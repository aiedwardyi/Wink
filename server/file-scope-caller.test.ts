import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommsCallers } from "./comms-caller.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { ownerChats } from "./one-mind.ts";
import { ownerOwnTurn, ownerTypedTurn } from "./owner-turn.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";
import { TurnRegistry, type LiveTurn } from "./turn-registry.ts";

// bot-a: a read-only joined-room guest. bot-b: the owner's own 1:1. bot-j: a joined-room guest who may make bots work.
// bot-h: a hosted room where a teammate who may make bots work asked an Auto bot.
const callers = new CommsCallers();
const bots: Record<string, { id: string; name: string; threadId: string; tasks: { threadId: string }[]; autoApprove?: boolean }> = {
  "bot-a": { id: "bot-a", name: "A", threadId: "chat-a", tasks: [{ threadId: "chat-a" }] },
  "bot-b": { id: "bot-b", name: "B", threadId: "chat-b", tasks: [{ threadId: "chat-b" }] },
  "bot-j": { id: "bot-j", name: "J", threadId: "chat-j", tasks: [{ threadId: "chat-j" }] },
  "bot-h": { id: "bot-h", name: "H", threadId: "chat-h", tasks: [{ threadId: "chat-h" }], autoApprove: true },
};
const room = { id: "group-h", threadId: "room-h", memberIds: ["bot-h"], hosted: { roomId: "r" } };

const index = ts.createSourceFile("index.ts", readFileSync(join(import.meta.dirname, "index.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`index.ts has no function ${name}`);
  const code = ts.transpileModule(node.getText(index), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `${code}\nreturn ${name};`)(...Object.values(deps));
}

let dir: string;
let taskDir: string;
let outside: string;
let inside: string;
let picture: string;
let insidePicture: string;
let packets: Map<string, TaskResumePacket>;
let turns: TurnRegistry;
let routes: ReturnType<typeof createInternalRoutes>;
let ownerFileStart: (botId: string, threadId: string, depth: number, typed: boolean) => boolean;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-scope-caller-"));
  taskDir = join(dir, "task");
  outside = join(dir, "outside.txt");
  inside = join(taskDir, "inside.txt");
  picture = join(dir, "outside.png");
  insidePicture = join(taskDir, "inside.png");
  mkdirSync(taskDir);
  writeFileSync(outside, "private");
  writeFileSync(inside, "work");
  writeFileSync(picture, PNG);
  writeFileSync(insidePicture, PNG);
  const threads = [...Object.values(bots).map((bot) => bot.threadId), room.threadId];
  packets = new Map(threads.map((threadId) => [threadId, seedTaskResumePacket({ threadId, botId: threadId === room.threadId ? "bot-h" : `bot-${threadId.slice(-1)}`, text: "Build the site", messageId: "m", now: 1, turnsAtWrite: 0 })]));
  turns = new TurnRegistry();
  const owns = (botId: string, threadId: string) =>
    threadId === room.threadId ? (botId === "bot-h" ? { group: room } : undefined) : bots[botId]?.threadId === threadId ? {} : undefined;
  const store = {
    bot: (id: string) => bots[id],
    groupByThread: (threadId: string) => (threadId === room.threadId ? room : undefined),
    conversationForBot: owns,
    taskByThread: (_botId: string, threadId: string) => (threadId === room.threadId ? undefined : { cwd: taskDir }),
    groupTaskByThread: () => ({ pinnedCwd: taskDir }),
    appendMessage: () => ({ id: "shown" }),
  };
  // what index.ts records as it dispatches each of these turns
  const readOnlyTurnThreads = new Set(["chat-a"]);
  const joinedRoomThreads = new Set(["chat-a", "chat-j"]);
  const joinedGuestThreads = new Set(["chat-a", "chat-j"]);
  const roomTaskThreads = new Set(["chat-a", "chat-j"]);
  const readOnlyAskTurn = () => false;
  const teammateAskTurn = (_roomId: string, threadId: string) => threadId === room.threadId;
  const readOnlyRoomTurn = load("readOnlyRoomTurn", { store, readOnlyTurnThreads, readOnlyAskTurn, teammateAskTurn });
  const guestRoomTurn = load("guestRoomTurn", { store, readOnlyRoomTurn, joinedGuestThreads, teammateAskTurn });
  const ownerFileFacts = load("ownerFileFacts", { turnRegistry: turns, store, ownerChats, notOwnerChats: () => roomTaskThreads, joinedRoomThreads, guestRoomTurn });
  const ownerFileTurn = load("ownerFileTurn", { ownerOwnTurn, ownerFileFacts });
  ownerFileStart = load("ownerFileStart", { ownerTypedTurn, ownerFileFacts });
  routes = createInternalRoutes({
    store,
    connectorThread: owns,
    taskPacketForWrite: (threadId: string) => structuredClone(packets.get(threadId)!),
    persistTaskPacket: (next: TaskResumePacket) => (packets.set(next.threadId, next), next),
    readOnlyTurn: readOnlyRoomTurn,
    ownerTurn: ownerFileTurn,
    resolveCommsCaller: (header: string | string[] | undefined) => callers.resolve(header),
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// the token a turn's tools got at dispatch: the owner's typed turn gets its own, every other turn shares the chat's
type Token = [botId: string, threadId: string, ownerFiles?: boolean];

async function post(route: "taskState" | "showImage", token: Token | null, body: object) {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = token ? { authorization: `Bearer ${callers.token(...token)}` } : {};
  let status = 0;
  let out = "";
  const res = { writeHead(code: number) { status = code; }, getHeader() {}, setHeader() {}, end(value: string) { out = value; } } as unknown as ServerResponse;
  const pending = routes[route](req, res);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  await pending;
  const parsed = JSON.parse(out || "{}") as { error?: string; notice?: string };
  return { status, error: parsed.error ?? "", notice: parsed.notice ?? "" };
}

const artifactsOf = (threadId: string) => packets.get(threadId)!.artifacts.map((artifact) => artifact.ref);
const live = (botId: string, threadId: string, turn: Partial<LiveTurn> = {}, turnId = `turn-${threadId}`) =>
  turns.start(turnId, { botId, threadId, owner: "user", depth: 0, typed: true, ...turn });
// an owner turn's token by default, so a folder-only result is the turn's doing, not the token's
const record = (botId: string, threadId: string, refs: string[], ownerFiles = true) =>
  post("taskState", [botId, threadId, ownerFiles], { fromBotId: botId, fromThreadId: threadId, artifacts: refs.map((ref) => ({ ref, label: "x" })) });
const show = (botId: string, threadId: string, path: string, ownerFiles = true) =>
  post("showImage", [botId, threadId, ownerFiles], { fromBotId: botId, fromThreadId: threadId, path });

describe("file scope follows the turn the token belongs to", () => {
  it("a read-only turn's token can't record an outside file on another chat's task", async () => {
    const result = await post("taskState", ["bot-a", "chat-a"], { fromBotId: "bot-b", fromThreadId: "chat-b", artifacts: [{ ref: outside, label: "x" }] });
    expect(result.status).toBe(403);
    expect(artifactsOf("chat-b")).toEqual([]);
  });

  it("a read-only turn's token can't show an outside picture in another chat", async () => {
    const result = await post("showImage", ["bot-a", "chat-a"], { fromBotId: "bot-b", fromThreadId: "chat-b", path: outside });
    expect(result.status).toBe(403);
    expect(result.error).toContain("does not belong to sender");
  });

  it("the owner's own typed turn records and shows any local file", async () => {
    live("bot-b", "chat-b");
    expect((await record("bot-b", "chat-b", [outside])).status).toBe(200);
    expect(artifactsOf("chat-b")).toEqual([realpathSync(outside)]);
    expect((await show("bot-b", "chat-b", picture)).status).toBe(201);
  });

  it("the boot token can still write for a named chat", async () => {
    const result = await post("taskState", null, { fromBotId: "bot-b", fromThreadId: "chat-b", artifacts: [{ ref: outside, label: "x" }] });
    expect(result.status).toBe(200);
  });
});

describe("only the owner's own 1:1 turn reads outside the bot's folders", () => {
  it("a joined-room guest who may make bots work, on its own token, gets folder-only pictures and artifacts", async () => {
    live("bot-j", "chat-j");
    expect((await show("bot-j", "chat-j", picture)).status).toBe(403);
    expect((await show("bot-j", "chat-j", insidePicture)).status).toBe(201);
    const saved = await record("bot-j", "chat-j", [outside, inside]);
    expect(saved.status).toBe(200);
    expect(saved.notice).toBe(`Dropped artifacts that are not files inside ${taskDir}: ${outside}.`);
    expect(artifactsOf("chat-j")).toEqual([realpathSync(inside)]);
  });

  it("a hosted room teammate's working turn gets folder-only pictures and artifacts", async () => {
    live("bot-h", room.threadId, { owner: "room", typed: undefined });
    expect((await show("bot-h", room.threadId, picture)).status).toBe(403);
    expect((await show("bot-h", room.threadId, insidePicture)).status).toBe(201);
    expect((await record("bot-h", room.threadId, [outside, inside])).status).toBe(200);
    expect(artifactsOf(room.threadId)).toEqual([realpathSync(inside)]);
  });

  it("a peer's ask, running in the owner's 1:1 on that chat's token, records only task-folder artifacts", async () => {
    live("bot-b", "chat-b", { owner: "peer", depth: 1, typed: false });
    expect((await record("bot-b", "chat-b", [outside, inside])).status).toBe(200);
    expect(artifactsOf("chat-b")).toEqual([realpathSync(inside)]);
    expect((await show("bot-b", "chat-b", picture)).status).toBe(403);
  });

  it.each([
    ["a routine, webhook, wake or card continuation", { typed: false }],
    ["another bot's turn", { botId: "bot-j" }],
  ])("%s in the owner's 1:1 gets folder-only", async (_, turn) => {
    live("bot-b", "chat-b", turn);
    expect((await show("bot-b", "chat-b", picture)).status).toBe(403);
    expect((await record("bot-b", "chat-b", [outside])).status).toBe(200);
    expect(artifactsOf("chat-b")).toEqual([]);
  });

  it("an owner chat's token after its turn ended gets folder-only", async () => {
    live("bot-b", "chat-b");
    turns.settle("turn-chat-b");
    expect((await show("bot-b", "chat-b", picture)).status).toBe(403);
    expect((await record("bot-b", "chat-b", [outside])).status).toBe(200);
    expect(artifactsOf("chat-b")).toEqual([]);
  });

  it.each([
    ["a peer's ask", { owner: "peer", depth: 1, typed: false }],
    ["a routine, webhook, wake or card continuation", { typed: false }],
  ] as const)("%s's token stays folder-only after the owner's next typed turn starts", async (_, earlier) => {
    live("bot-b", "chat-b", earlier, "turn-1");
    turns.settle("turn-1");
    live("bot-b", "chat-b", {}, "turn-2");
    expect((await show("bot-b", "chat-b", picture, false)).status).toBe(403);
    expect((await record("bot-b", "chat-b", [outside], false)).status).toBe(200);
    expect(artifactsOf("chat-b")).toEqual([]);
    expect((await show("bot-b", "chat-b", picture)).status).toBe(201);
    expect((await record("bot-b", "chat-b", [outside])).status).toBe(200);
    expect(artifactsOf("chat-b")).toEqual([realpathSync(outside)]);
  });

  it("a read-only joined-room turn is still refused task updates and kept to its folders for pictures", async () => {
    live("bot-a", "chat-a");
    expect((await record("bot-a", "chat-a", [inside])).status).toBe(403);
    expect((await show("bot-a", "chat-a", picture)).status).toBe(403);
    expect((await show("bot-a", "chat-a", insidePicture)).status).toBe(201);
  });

  it("dispatch gives the owner token only to the owner's own typed 1:1 turn", () => {
    expect(ownerFileStart("bot-b", "chat-b", 0, true)).toBe(true);
    expect(ownerFileStart("bot-b", "chat-b", 1, true)).toBe(false);
    expect(ownerFileStart("bot-b", "chat-b", 0, false)).toBe(false);
    expect(ownerFileStart("bot-j", "chat-j", 0, true)).toBe(false);
    expect(ownerFileStart("bot-h", room.threadId, 0, true)).toBe(false);
    const source = index.getFullText();
    expect(source).toContain("commsCallers.token(botId, threadId, ownerFiles)");
    expect(source).toContain("agentsIntegration(bot.id, threadId, commsDepth, false, readOnly, false, importMemory, ownerFileStart(bot.id, threadId, commsDepth, turnStartedByUser(opts)))");
  });

  it("opens an unrestricted file scope only through owner-turn.ts", () => {
    const opened = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "owner-turn.ts")
      .filter((file) => readFileSync(join(import.meta.dirname, file), "utf8").split("\n").some((line) => /kind:\s*"any"/.test(line) && !line.includes("type FileScope =")));
    expect(opened, 'pick a file scope with fileScope(deps.ownerTurn(caller, botId, threadId), roots) from owner-turn.ts, never a literal { kind: "any" }').toEqual([]);
  });
});
