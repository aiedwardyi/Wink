import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { Store, type GroupRecord } from "../store.ts";
import { closeRoomsDb } from "./db.ts";
import { hostedRoomView, isHostedThread, linkedFilesClosed } from "./guards.ts";

const SERVER = join(import.meta.dirname, "..");
const parse = (file: string) => {
  const source = readFileSync(join(SERVER, file), "utf8").replace(/\r\n/g, "\n");
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
};
const index = parse("index.ts");
const botChat = parse("bot-chat-routes.ts");
const js = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
const build = (code: string, name: string, deps: Record<string, unknown>) =>
  new Function(...Object.keys(deps), `${js(code)}\nreturn ${name};`)(...Object.values(deps));

function find<T extends ts.Node>(file: ts.SourceFile, test: (node: ts.Node) => node is T): T {
  const walk = (node: ts.Node): T | undefined => (test(node) ? node : ts.forEachChild(node, walk));
  const node = walk(file);
  expect(node).toBeDefined();
  return node!;
}

/** A top-level function or const of index.ts. */
function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) =>
    (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => item.name.getText(index) === name)));
  expect(node).toBeDefined();
  return build(node!.getText(index), name, deps);
}

/** The request handler's `if` block that contains `marker`, as invoke(path, method, m). */
function routeBlock(marker: string, deps: Record<string, unknown>) {
  const node = find(index, (n): n is ts.IfStatement => ts.isIfStatement(n) && ts.isBlock(n.thenStatement) && n.getText(index).includes(marker)
    && !n.thenStatement.statements.some((s) => ts.isIfStatement(s) && s.getText(index).includes(marker)));
  return build(`async function invoke(req, res, path, method, url, m) { ${node.getText(index)} }`, "invoke", deps);
}

let store: Store;
let plain: GroupRecord;
let hosted: GroupRecord;
const json = (_res: unknown, status: number, body: unknown) => ({ status, body });

beforeEach(() => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  const bot = store.createBot();
  plain = store.createGroup("Plain", [bot.id]);
  hosted = store.createGroup("Team", [bot.id], false, undefined, undefined, { roomId: "restored-room" });
});
afterEach(closeRoomsDb);

describe("team rooms on the phone", () => {
  it("includes hosted and joined frames live and in replay, while keeping screen filtering", () => {
    const wants = load("wants", {});
    const replayBuffer: Array<{ kind: string; frame: string }> = [];
    const phone = { res: { write: vi.fn() }, screens: true };
    const desktop = { res: { write: vi.fn() }, screens: true };
    const write = load("writeBroadcastFrame", {
      lastSeq: 0, STREAM_ID: "s", REPLAY_MAX: 500, replayBuffer, sseClients: new Set([phone, desktop]), wants,
      maskRuntimePayload: (p: unknown) => p, redactSecrets: (p: unknown) => p, store,
    });
    write({ kind: "message", threadId: hosted.threadId, message: { text: "room line" } });
    write({ kind: "message", threadId: plain.threadId, message: { text: "plain line" } });
    write({ kind: "joined", hosted: true, roomId: "r9" });
    expect(desktop.res.write).toHaveBeenCalledTimes(3);
    expect(phone.res.write).toHaveBeenCalledTimes(3);
    expect(phone.res.write.mock.calls[0][0]).toContain("room line");
    expect(replayBuffer.filter((item) => wants(phone, item.kind)).map((item) => item.frame)).toEqual(phone.res.write.mock.calls.map((call) => call[0]));
    expect(wants({ screens: false }, "screen")).toBe(false);
    expect(wants(phone, "screen")).toBe(true);
  });

  it("keeps the same manual group order for relay callers", async () => {
    const deps = (relay: boolean) => ({
      relay, store, json, traceOpenBots: () => {}, pageSize: () => undefined, OPEN_CHAT_HEADER: "x-open-chat", offscreenLimit: () => 0,
      publicBotRecord: (bot: unknown) => bot, messagePage: () => ({}), publicGroupState: (group: GroupRecord) => group,
      computerControl: { snapshot: () => ({ held: false }) }, STREAM_ID: "s", lastSeq: 0,
    });
    const run = (relay: boolean) => routeBlock('path === "/api/bots"', deps(relay))({ headers: {} }, {}, "/api/bots", "GET", new URL("http://x/api/bots"));
    expect((await run(true)).body.groups.map((g: GroupRecord) => g.id)).toEqual([hosted.id, plain.id]);
    expect((await run(false)).body.groups.map((g: GroupRecord) => g.id)).toEqual([hosted.id, plain.id]);
  });

  it("includes hosted threads in relay search", async () => {
    const search = vi.fn();
    const run = (relay: boolean) => routeBlock('path === "/api/search"', { relay, store, threadRoutes: { search } })({}, "res", "/api/search", "GET", "url");
    await run(true);
    await run(false);
    expect(search.mock.calls).toEqual([["res", "url"], ["res", "url"]]);
  });

  it("sends no phone push for a hosted room", () => {
    const broadcast = vi.fn();
    const phonePing = vi.fn();
    const notify = load("notify", { broadcast, phonePing, pingForNotification: () => ({}), routineTriggerIsUnattended: () => false, isHostedThread, store });
    notify({ botId: "bot", threadId: hosted.threadId });
    notify({ botId: "bot", threadId: plain.threadId });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(phonePing.mock.calls.map((call) => call[2].threadId)).toEqual([plain.threadId]);
  });
});

describe("hosted thread seams", () => {
  it("serves no linked file or folder from a hosted thread", async () => {
    const serveLinkedFile = vi.fn();
    const serveLinkedFolder = vi.fn();
    const invoke = routeBlock(": serveLinkedFile)(", { store, json, serveLinkedFile, serveLinkedFolder, credentials: {}, linkedFilesClosed });
    for (const kind of ["file", "folder"]) {
      const path = `/api/threads/${hosted.threadId}/linked-${kind}`;
      expect(await invoke({}, {}, path, "GET", new URL(`http://x${path}`), ["", hosted.threadId, kind])).toEqual({ status: 404, body: { error: "no such conversation" } });
    }
    expect(serveLinkedFile).not.toHaveBeenCalled();
    expect(serveLinkedFolder).not.toHaveBeenCalled();
  });

  it("continues a card in a shared group like any group", () => {
    const groupTaskResumes = new Map();
    const beginGroupTurnOperation = vi.fn(() => 1);
    const start = load("startGroupCardContinuation", {
      store, groupTaskResumes, beginGroupTurnOperation, groupQueues: new Map(), drainQueuedSends: () => {}, finishGroupTurnOperation: () => {},
    });
    start(hosted.id, hosted.threadId, "bot", "resume");
    expect(groupTaskResumes.size).toBe(1);
    expect(beginGroupTurnOperation).toHaveBeenCalled();
    start(plain.id, plain.threadId, "bot", "resume");
    expect(groupTaskResumes.size).toBe(2);
  });

  it("refuses task resume in a hosted room", async () => {
    const handler = find(botChat, (n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && n.name.getText(botChat) === "resumeTask");
    const fn = handler.initializer as ts.ArrowFunction;
    const startGroupCardContinuation = vi.fn();
    const resume = build(`async function resumeTask(res, m) ${fn.body.getText(botChat)}`, "resumeTask", {
      store: { bot: () => ({ id: "bot" }), conversationForBot: (_bot: string, threadId: string) => ({ group: store.groupByThread(threadId) }) },
      json, cancelUsageWait: () => {}, taskPacketForWrite: () => ({ flushReason: "interrupted" }), isRecoveryFlushReason: () => true,
      isCompletedTaskRecord: () => false, startGroupCardContinuation, TASK_RESUME_PROMPT: "resume",
      taskResumes: { request: async () => ({ pending: true }) }, queueMark: () => 0, drainQueuedSends: () => {},
    });
    expect(await resume({}, ["", "bot", hosted.threadId])).toEqual({ status: 409, body: { error: "team rooms don't continue tasks" } });
    expect(startGroupCardContinuation).not.toHaveBeenCalled();
    expect((await resume({}, ["", "bot", plain.threadId])).status).toBe(202);
  });

  it("reports a restored room's missing data on the group", () => {
    const state = load("publicGroupState", {
      store, groupClears: () => ({}), groupIsWorking: () => false, wireGroupTask: (task: unknown) => task, hostedRoomView,
    });
    expect(state(hosted).room).toEqual({ missing: true });
    expect("room" in state(plain)).toBe(false);
  });
});
