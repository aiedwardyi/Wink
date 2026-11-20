import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { peerMessagePrompt } from "./chief-of-staff.ts";
import { botRoute, CommsCallers } from "./comms-caller.ts";
import * as roots from "./comms-root.ts";
import { ensureDirs } from "./config.ts";
import { paneNotesForTurn, prepareModelContext, withoutTurnNotes } from "./context-compaction.ts";
import { recordDelegationReceipt, resetDelegationReceipts } from "./delegation-ledger.ts";
import { NoteSteerer, steerUntilTaken } from "./note-steer.ts";
import { roomEchoesSinceLastUserTurn, writeRoomEcho } from "./one-mind.ts";
import type { Message } from "./store.ts";
import { buildTurnContext } from "./turn-context.ts";
import { turnRegistry } from "./turn-registry.ts";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const PROXY = fileURLToPath(new URL("./drivers/agents-proxy.ts", import.meta.url));
const BASE_PEER_TOOLS = ["check_delegation", "list_bots", "list_routines", "update_task_state", "wait_delegation"];
const commsCallers = new CommsCallers();
let port = 0;
let proposal: unknown;
const harness = createServer((req, res) => {
  const caller = commsCallers.resolve(req.headers.authorization);
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/internal/owner-peer-tools") {
    const key = caller && turnRegistry.privatePeerKey(caller.botId, caller.threadId);
    return res.end(JSON.stringify({ allowed: Boolean(key && key === req.headers["x-wink-owner-hop"]) }));
  }
  if (caller?.botId === "evals" && req.url === "/api/internal/routine-requests") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      proposal = JSON.parse(body);
      res.writeHead(201);
      res.end(JSON.stringify({ requestId: "draft", summary: "Needs the owner's confirmation." }));
    });
    return;
  }
  res.writeHead(404).end("{}");
});
beforeAll(async () => {
  ensureDirs();
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  port = (harness.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve, reject) => harness.close((error) => error ? reject(error) : resolve())));
const compact = (text: string) => text.replace(/\s+/g, " ").trim();
const js = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const nodes = <T extends ts.Node>(guard: (node: ts.Node) => node is T): T[] => {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

afterEach(() => {
  for (const threadId of ["wink-thread", "chief-thread", "evals-thread"]) {
    turnRegistry.cancel(threadId);
    const turn = turnRegistry.current(threadId);
    if (turn) turnRegistry.settle(turn.turnId);
  }
  roots._resetCommsRoots();
  resetDelegationReceipts();
  proposal = undefined;
  vi.restoreAllMocks();
});

const startTurnOptions = (marker: string) => nodes(ts.isCallExpression)
  .find((node) => node.expression.getText(source) === "startTurn" && compact(node.arguments[2]?.getText(source) ?? "").includes(marker))!
  .arguments[2]!.getText(source);

function joinedStart(guest: boolean) {
  const arrow = nodes(ts.isPropertyAssignment).find((node) => node.name.getText(source) === "startTurn" && node.initializer.getText(source).includes("transcriptText: typed"))!.initializer.getText(source);
  let captured: Record<string, unknown> = {};
  new Function("startTurn", "joinedRoomThreads", `return ${js(arrow)}`)((_botId: string, _prompt: string, opts: Record<string, unknown>) => { captured = opts; }, new Set())("bot", "joined-thread", "prompt", "typed", () => {}, false, guest);
  return captured;
}

function chatStart() {
  const arrow = nodes(ts.isPropertyAssignment).find((node) => node.name.getText(source) === "startTurn" && node.initializer.getText(source).includes("...opts"))!.initializer.getText(source);
  let captured: Record<string, unknown> = {};
  new Function("startTurn", `return ${js(arrow)}`)((_botId: string, _text: string, opts: Record<string, unknown>) => { captured = opts; })("wink", "line", { threadId: "wink-thread" });
  return captured;
}

function rootFor(threadId: string, opts: Record<string, unknown>, messageId: string) {
  const root = nodes(ts.isVariableDeclaration).find((node) => node.name.getText(source) === "rootId" && node.initializer?.getText(source).includes("turnStartedByUser(opts)"))!;
  const predicate = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "turnStartedByUser")!;
  return new Function("rootForStart", "threadId", "opts", "commsDepth", "userMessage", js(`${predicate.getText(source)}\nreturn ${root.initializer!.getText(source)};`))(roots.rootForStart, threadId, opts, Number(opts.commsDepth ?? 0), { id: messageId });
}

const hopOptions = {
  ask: (callerRoot: string | null, taskId?: string) => new Function("depth", "peer", "fromBotId", "isUnattended", "peerAttribution", "onDispatchError", `return ${js(`(${startTurnOptions("commsRoot: peer?.commsRoot ?? null")})`)}`)(0, { commsRoot: callerRoot, taskId }, "wink", () => false, () => ({}), () => {}),
  delegation: (callerRoot: string | null, taskId?: string) => new Function("commsDepth", "root", "reservation", "ask", "isUnattended", "sourceBotId", "transcriptText", "peerAttribution", "store", "channel", "reportStartFailure", "taskId", `return ${js(`(${startTurnOptions("commsRoot: root ?? null")})`)}`)(1, callerRoot ?? undefined, undefined, undefined, () => false, "wink", "", () => ({}), { bot: () => undefined }, undefined, () => {}, taskId),
};

function agentsEnv(mountIndex: number, scope: { commsDepth?: number; hop?: number; rootId?: string | null; asked?: string; guestAsked?: boolean; foreign?: boolean }): Record<string, string> {
  const integration = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "agentsIntegration")!;
  const agentsIntegration = new Function("process", "agentsProxyPath", "AGENTS_NODE_FLAG", "PORT", "commsCallers", "teamReports", `${js(integration.getText(source))}; return agentsIntegration;`)(
    { env: {} }, PROXY, {}, port, commsCallers, { prompt: () => "" },
  );
  const mounts = nodes(ts.isIfStatement).filter((node) => node.thenStatement.getText(source).includes("integrations.agents = agentsIntegration("));
  const integrations: { agents?: { env: Record<string, string> } } = {};
  new Function("integrations", "instance", "bot", "threadId", "commsDepth", "hop", "readOnly", "importMemory", "searchable", "works", "handoff", "agentsIntegration", mounts[mountIndex]!.getText(source))(
    integrations, { adapter: { capabilities: { agentsMcp: true } } }, { id: "evals" }, "evals-thread", scope.commsDepth ?? 0, scope.hop ?? 0, false, { tool: false }, false, true, null, agentsIntegration,
  );
  return integrations.agents!.env;
}

async function wakeStart(run: Record<string, unknown>, room: boolean) {
  const arrow = nodes(ts.isPropertyAssignment).find((node) => node.name.getText(source) === "startChatTurn")!.initializer.getText(source);
  const seen: { rootId?: string | null; opts?: Record<string, unknown> } = {};
  const scope = {
    routineSourceOwner: () => ({ bot: { id: "wink" }, threadId: "wink-thread", ...(room ? { group: { id: "room" } } : {}) }),
    botHasActiveTurn: () => false, busyRejection: (message: string) => new Error(message), routineTriggerIsUnattended: () => false, markUnattended: () => {},
    runGroupMemberTurn: (...args: unknown[]) => { seen.rootId = args[10] as string | null; return Promise.resolve(true); },
    routines: { isCancelled: () => false }, rootForStart: roots.rootForStart,
    startTurn: async (_botId: string, _line: string, opts: Record<string, unknown>) => { seen.opts = opts; },
  };
  await new Function(...Object.keys(scope), `return ${js(arrow)}`)(...Object.values(scope))({ triggerSource: "schedule", ...run }, "[Wake]", () => {});
  return seen;
}

function paneWake(admission: { rootId: string | null; reservation: unknown }) {
  const credit = nodes(ts.isVariableDeclaration).find((node) => node.name.getText(source) === "credit" && node.initializer!.getText(source).includes("admission.reservation"))!;
  return new Function("admission", "threadId", js(`const credit = ${credit.initializer!.getText(source)};\nreturn ${startTurnOptions("paneNoteWake: true")};`))(admission, "chief-thread") as Record<string, unknown>;
}

function fold(rootId: string | null, from: "activePath" | "pathTail") {
  const loop = nodes(ts.isForOfStatement).find((node) => node.getText(source).includes(`store.${from}(threadId`) && node.getText(source).includes("adoptHumanRoot"))!;
  const store = { activePath: () => [{ id: "owner-steer" }], pathTail: () => [{ id: "owner-steer" }] };
  return new Function("store", "threadId", "folded", "queued", "adoptHumanRoot", "rootId", `${js(loop.getText(source))}\nreturn rootId;`)(store, "evals-thread", ["steer"], ["steer"], roots.adoptHumanRoot, rootId) as string | null;
}

function proxyRequest(env: Record<string, string>, method: string, params?: Record<string, unknown>): Promise<any> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
  const script = 'import { pathToFileURL } from "node:url"; const { handle } = await import(pathToFileURL(process.argv[2])); await handle(JSON.parse(process.argv[3]));';
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const proxy = spawn(process.execPath, ["--input-type=module", "-e", script, "probe", PROXY, request], { windowsHide: true, env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    proxy.stdout!.on("data", (chunk) => { buf += chunk; });
    proxy.once("error", reject);
    proxy.once("close", (code) => {
      if (code !== 0 || !buf.trim()) return reject(new Error(`proxy exited ${code}`));
      try { resolve(JSON.parse(buf.trim()).result); }
      catch (error) { reject(error); }
    });
  });
}

async function listedTools(env: Record<string, string>): Promise<string[]> {
  const reply = await proxyRequest(env, "tools/list");
  return reply.tools.map((tool: { name: string }) => tool.name).sort();
}

const ownerLine: Message = { id: "owner-line", at: 1, role: "user", kind: "text", text: "Draft the evaluation routine." };
const report: Message = { id: "note", at: 2, role: "bot", kind: "note", noteType: "team-report", quiet: true, reportIds: ["fixture"], text: "The export finished." };

function privateDispatch(botId: string, threadId: string, opts: Record<string, unknown>, rows: Message[], context: Record<string, unknown> = {}) {
  const userMessage = rows.at(-1)!;
  const commsDepth = Number(opts.commsDepth ?? 0);
  const rootId = rootFor(threadId, opts, userMessage.id);
  const env = agentsEnv(0, { commsDepth, rootId });
  turnRegistry.prepare({ botId, threadId, owner: commsDepth ? "peer" : "user", depth: commsDepth, rootId });
  const start = source.text.indexOf("        const source = commsDepth === 1 ? privatePeerTask(");
  const end = source.text.indexOf("        return live.adapter.sendTurn(", start);
  const scope = {
    bot: { id: botId }, threadId, commsDepth, opts, rootId, userMessage, turnRegistry, randomUUID,
    privatePeerTask: roots.privatePeerTask, integrations: { agents: { env } },
    readOnly: false, hasProviderHistory: false, priorTaskPacket: null, rewound: false, recycled: false, systemRecycle: false,
    notOwnerChats: () => new Set(), store: { messagesFor: () => rows, groupByThread: () => undefined },
    text: userMessage.text, entryText: userMessage.text, transcript: [], resumeCursor: undefined, systemUpdate: "",
    ...context,
  };
  expect(start).toBeGreaterThanOrEqual(0);
  new Function(...Object.keys(scope), js(source.text.slice(start, end)))(...Object.values(scope));
  turnRegistry.started(`${threadId}-turn`, threadId);
  return { env, rootId };
}

function peerDispatch(kind: "ask" | "delegation", context: Record<string, unknown> = {}, settleSource = false) {
  const caller = roots.callerSnapshot("wink", "wink-thread")!;
  const taskId = randomUUID();
  recordDelegationReceipt({
    id: taskId, status: "running", kind, sourceThreadId: caller.threadId, root: caller.rootId ?? undefined,
    source: { botId: caller.botId, threadId: caller.threadId, turnId: caller.turnId },
    toBotId: "evals", toBotName: "Evals", target: { botId: "evals", threadId: "evals-thread" },
  });
  if (settleSource) turnRegistry.settle(caller.turnId);
  const chip: Message = { id: "chip", at: 1, role: "bot", kind: "activity", tool: { name: "Message from @Wink" }, comm: { groupId: "dm", withBotId: "wink", withName: "Wink", withColor: "", peer: "from" } };
  const line: Message = { id: "peer-line", at: 2, role: "user", kind: "text", text: "Draft the routine." };
  const framed = peerMessagePrompt({ name: "Wink" }, line.text!, kind);
  return privateDispatch("evals", "evals-thread", hopOptions[kind](caller.rootId, taskId), [chip, line], { entryText: framed, text: framed, ...context }).env;
}

function liveSteer(rootId: string, rows: Message[], take = true) {
  const deps = nodes(ts.isNewExpression).find((node) => node.expression.getText(source) === "NoteSteerer")!.arguments![0] as ts.ObjectLiteralExpression;
  const steer = deps.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText(source) === "steer")!.initializer.getText(source);
  const adapter = { capabilities: { queueing: true, steerConsumed: true }, steer: async (_threadId: string, _text: string, consumed: (taken: boolean) => void) => { if (take) consumed(true); return take; } };
  const store = { bot: () => ({ id: "chief", threadId: "chief-thread" }), row: (_threadId: string, id: string) => rows.find((row) => row.id === id) };
  return new NoteSteerer({
    enabled: () => true, paused: () => false, liveTurn: () => "live-turn", busy: () => true, messages: () => rows, deliveredId: () => undefined, markDelivered: () => {}, wake: () => {},
    steer: new Function("store", "botAccounts", "steerUntilTaken", "peerInputJoined", "othersInPrompt", "turnRegistry", `return ${js(steer)}`)(store, { instance: () => ({ adapter }) }, steerUntilTaken, () => {}, roots.othersInPrompt, { rootOf: () => rootId }),
  });
}

async function afterRoomEcho(foreign: boolean, legacy = false) {
  const call = nodes(ts.isCallExpression).find((node) => node.expression.getText(source) === "writeRoomEcho")!;
  const rows = new Map<string, Message[]>([["room-thread", [
    { id: "ask", at: 1, role: "user", kind: "text", text: "@Wink set up the eval routine" },
    { id: "answer", at: 2, role: "bot", kind: "text", text: "Drafted it.", from: { botId: "wink", name: "Wink", color: "blue" } },
  ]]]);
  const group = { id: "room", name: "Team room", hosted: { roomId: "room" } };
  const store = {
    bot: () => undefined,
    group: () => group,
    messagesFor: (threadId: string) => rows.get(threadId) ?? [],
    row: (threadId: string, id: string) => rows.get(threadId)?.find((row) => row.id === id),
    appendMessage: (threadId: string, row: Omit<Message, "id" | "at">) => {
      const saved = { ...row, id: "echo", at: 3 };
      rows.set(threadId, [...(rows.get(threadId) ?? []), saved]);
      return saved;
    },
  };
  const echo = new Function("writeRoomEcho", "store", "bot", "group", "threadId", "messagesAtStart", "userName", "dispatchedInstructionId", "foreign", `return ${call.getText(source)};`)(
    writeRoomEcho, store, { id: "wink", threadId: "wink-thread" }, group, "room-thread", 1, "Edward", "ask", foreign,
  ) as Message;
  if (legacy) echo.roomEcho = { groupId: group.id };
  const drafted = [echo, ownerLine];
  const rendered = [...roomEchoesSinceLastUserTurn(drafted, new Set(), "Edward"), ownerLine.text].join("\n\n");
  const owner = privateDispatch("wink", "wink-thread", chatStart(), drafted, { text: rendered });
  expect(roots.othersInPrompt(store, "wink-thread", owner.rootId, [echo.id])).toBe(foreign || legacy);
  return listedTools(peerDispatch("delegation"));
}

it.each(["ask", "delegation"] as const)("gives a %s a joined room's other person started only the base peer tools", async (kind) => {
  const callerRoot = rootFor("joined-thread", joinedStart(true), "guest-line");
  expect(callerRoot).not.toBeNull();
  const opts = hopOptions[kind](callerRoot);
  const env = agentsEnv(0, { commsDepth: Number(opts.commsDepth), rootId: rootFor("evals-thread", opts, "peer-line") });
  expect(await listedTools(env)).toEqual(BASE_PEER_TOOLS);
});

it.each(["ask", "delegation"] as const)("opens 20 tools for a fresh Wink to Evals %s and proposes a routine", async (kind) => {
  privateDispatch("wink", "wink-thread", chatStart(), [ownerLine]);
  const env = peerDispatch(kind, {}, kind === "delegation");
  const tools = await listedTools(env);
  expect(tools).toHaveLength(20);
  expect(tools).toEqual(expect.arrayContaining(["propose_routine", "propose_routine_action", "set_keep_going"]));
  for (const name of ["ask_bot", "delegate_bot", "create_bot", "create_channel"]) expect(tools).not.toContain(name);
  const args = { name: "Evaluation", instructions: "Check runs.", schedule: { type: "daily", time: "09:00" } };
  const result = await proxyRequest(env, "tools/call", { name: "propose_routine", arguments: args });
  expect(result.isError).toBe(false);
  expect(proposal).toMatchObject({ fromBotId: "evals", fromThreadId: "evals-thread", action: "create" });
});

it("guards a hop started by the owner in a joined room", async () => {
  privateDispatch("wink", "wink-thread", joinedStart(false), [ownerLine]);
  expect(await listedTools(peerDispatch("ask"))).toEqual(BASE_PEER_TOOLS);
});

it("gives only base tools after a delivered teammate report reaches a fresh engine in replay", async () => {
  const current = { ...ownerLine, id: "follow-up", at: 3, text: "What happened?" };
  const rows = [ownerLine, report, current];
  const skip = new Set([current.id]);
  const notes = paneNotesForTurn(rows, skip, report.id, true, true, 200_000);
  expect(notes.ids).toEqual([]);
  const prepared = await prepareModelContext({ messages: rows, excludeIds: skip, contextWindow: 200_000, taskRecordText: "" });
  if (prepared.status !== "ready") throw new Error(prepared.status);
  const transcript = withoutTurnNotes(prepared.transcript, notes.notes);
  const turn = buildTurnContext({ text: current.text, transcript, fresh: true, rewound: false, replaysNatively: false });
  expect(turn.turnText).toContain(report.text);
  privateDispatch("wink", "wink-thread", chatStart(), rows, { text: turn.turnText, transcript });
  const env = peerDispatch("delegation");
  expect(await listedTools(env)).toEqual(BASE_PEER_TOOLS);
  expect((await proxyRequest(env, "tools/call", { name: "propose_routine" })).isError).toBe(true);
  expect(proposal).toBeUndefined();
});

it("gives a room hop a guest's ask started only the base peer tools", async () => {
  expect(await listedTools(agentsEnv(1, { hop: 1, asked: "ask-1", guestAsked: true }))).toEqual(BASE_PEER_TOOLS);
  expect(await listedTools(agentsEnv(1, { hop: 1, asked: "ask-1", guestAsked: false }))).toEqual(BASE_PEER_TOOLS);
  const ownerLine = roots.rootForStart("room-thread", { kind: "human", messageKey: "owner-line" });
  expect(await listedTools(agentsEnv(1, { hop: 1, rootId: ownerLine }))).toEqual(BASE_PEER_TOOLS);
  expect(await listedTools(agentsEnv(1, { hop: 1 }))).toEqual(BASE_PEER_TOOLS);
});

it("gives the next room speaker after any wake only the base peer tools, beside a live owner root", async () => {
  roots.rootForStart("wink-thread", { kind: "human", messageKey: "owner-line" });
  for (const run of [{ id: "owner-wake", wake: true, ownerChain: true }, { id: "guest-wake", wake: true }]) {
    const { rootId } = await wakeStart(run, true);
    expect(await listedTools(agentsEnv(1, { hop: 1, rootId })), run.id).toEqual(BASE_PEER_TOOLS);
  }
});

it("gives a hop from any private wake only the base peer tools, beside a live owner root", async () => {
  roots.rootForStart("wink-thread", { kind: "human", messageKey: "owner-line" });
  for (const run of [{ id: "owner-wake", wake: true, ownerChain: true }, { id: "guest-wake", wake: true }]) {
    const { opts } = await wakeStart(run, false);
    const hop = hopOptions.ask(rootFor("wink-thread", opts!, "wake-line"));
    expect(await listedTools(agentsEnv(0, { commsDepth: Number(hop.commsDepth), rootId: rootFor("evals-thread", hop, "peer-line") })), run.id).toEqual(BASE_PEER_TOOLS);
  }
});

it("gives the peer of a Chief a teammate report woke only the base peer tools, beside a live owner root", async () => {
  roots.rootForStart("chief-thread", { kind: "human", messageKey: "owner-line" });
  const hop = hopOptions.ask(rootFor("chief-thread", paneWake({ rootId: null, reservation: null }), "report-wake"));
  expect(await listedTools(agentsEnv(0, { commsDepth: Number(hop.commsDepth), rootId: rootFor("evals-thread", hop, "peer-line") }))).toEqual(BASE_PEER_TOOLS);
});

it("gives the peer of a reply wake only the owner's tools its prompt allows", async () => {
  const owner = roots.rootForStart("chief-thread", { kind: "human", messageKey: "owner-line" })!;
  const peerTools = async () => {
    const credit = roots.reserve(owner, "wake");
    const hop = hopOptions.ask(rootFor("chief-thread", paneWake({ rootId: owner, reservation: credit.ok ? credit.reservation : null }), "reply-wake"));
    return listedTools(agentsEnv(0, { commsDepth: Number(hop.commsDepth), rootId: rootFor("evals-thread", hop, "peer-line") }));
  };
  expect(await peerTools()).toEqual(BASE_PEER_TOOLS);
  const reply: Message = { id: "guest-reply", at: 1, role: "bot", kind: "activity", comm: { groupId: "dm", withBotId: "guest-bot", withName: "Guest", withColor: "blue", peer: "reply", taskId: "guest-task" } };
  expect(roots.othersInPrompt({ row: () => undefined }, "chief-thread", owner, [], [reply])).toBe(true);
  expect(await peerTools()).toEqual(BASE_PEER_TOOLS);
});

it("gives no harness-started turn the owner origin of the root its thread holds", async () => {
  roots.rootForStart("wink-thread", { kind: "human", messageKey: "owner-line" });
  const automatic = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "rootForStart" && compact(node.arguments[1]?.getText(source) ?? "") === '{ kind: "automatic" }');
  expect(automatic.map((node) => compact(node.arguments[0]!.getText(source)))).toEqual(["threadId", "threadId", "source.threadId", "entry.threadId", "entry.threadId", "threadId"]);
  const at = (call: ts.CallExpression) => new Function("rootForStart", "threadId", "source", "entry", `return ${call.getText(source)};`)(roots.rootForStart, "wink-thread", { threadId: "wink-thread" }, { threadId: "wink-thread" }) as string | null;
  for (const call of automatic) expect(roots.ownerRoot(at(call)), call.getText(source)).toBe(false);
  for (const opts of [{ cardContinuation: true }, { automationSource: "schedule" }, { cardContinuation: true, paneNoteWake: true }]) expect(roots.ownerRoot(rootFor("wink-thread", opts, "continued")), JSON.stringify(opts)).toBe(false);
  expect(await listedTools(agentsEnv(1, { hop: 1, rootId: at(automatic[1]!) }))).toEqual(BASE_PEER_TOOLS);
  const hop = hopOptions.delegation(rootFor("wink-thread", { cardContinuation: true }, "resumed"));
  expect(await listedTools(agentsEnv(0, { commsDepth: Number(hop.commsDepth), rootId: rootFor("evals-thread", hop, "peer-line") }))).toEqual(BASE_PEER_TOOLS);
});

it.each(["activePath", "pathTail"] as const)("never upgrades a guest-started peer an owner steer folds into (%s)", async (from) => {
  const guest = hopOptions.ask(rootFor("joined-thread", joinedStart(true), "guest-line"));
  const guestEnv = agentsEnv(0, { commsDepth: Number(guest.commsDepth), rootId: fold(rootFor("evals-thread", guest, "guest-peer"), from) });
  expect(await listedTools(guestEnv)).toEqual(BASE_PEER_TOOLS);
  const owner = hopOptions.ask(rootFor("wink-thread", chatStart(), "owner-line"));
  const ownerEnv = agentsEnv(0, { commsDepth: Number(owner.commsDepth), rootId: fold(rootFor("evals-thread", owner, "owner-peer"), from) });
  expect(await listedTools(ownerEnv)).toEqual(BASE_PEER_TOOLS);
});

it.each(["activePath", "pathTail"] as const)("never upgrades a guest root that expired before an owner steer folds in (%s)", async (from) => {
  const guest = hopOptions.ask(rootFor("joined-thread", joinedStart(true), "guest-line"));
  const peer = rootFor("evals-thread", guest, "guest-peer");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);
  expect(await listedTools(agentsEnv(0, { commsDepth: Number(guest.commsDepth), rootId: fold(peer, from) }))).toEqual(BASE_PEER_TOOLS);
});

it("gives a room hop holding someone else's line only the base peer tools, even on an owner's ask or root", async () => {
  const ownerLine = roots.rootForStart("room-thread", { kind: "human", messageKey: "owner-line" });
  expect(await listedTools(agentsEnv(1, { hop: 1, asked: "ask-1", guestAsked: false, foreign: true }))).toEqual(BASE_PEER_TOOLS);
  expect(await listedTools(agentsEnv(1, { hop: 1, rootId: ownerLine, foreign: true }))).toEqual(BASE_PEER_TOOLS);
});

it("keeps the general comms origin checks", () => {
  const checks = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "othersInPrompt");
  expect(checks.map((node) => compact(node.getText(source)))).toEqual([
    "othersInPrompt(store, threadId, turnRegistry.rootOf(threadId), ids)",
    "othersInPrompt(store, threadId, rootId, [...paneNoteIds ?? [], ...mailParts.map((part) => part.id), ...carriedEchoes(threadId)])",
    "othersInPrompt(store, threadId, rootId, [...refreshedNotes.ids ?? [], ...carriedEchoes(threadId)])",
    "othersInPrompt(store, threadId, rootId, roomMail.map((part) => part.id), roomRows, group.hosted ? roomHostSeats(group.hosted.roomId) : [])",
  ]);
});

it("limits peer grants to the private send and inventories turn input boundaries", () => {
  const entries = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "startTurn")
    .map((node) => compact(node.arguments[2]?.getText(source) ?? ""));
  expect(entries.filter((entry) => entry.includes("privateOwner: true"))).toEqual(["{ ...opts, owner: true, privateOwner: true }"]);
  expect(entries.filter((entry) => entry.includes("peerTaskId:")).map((entry) => /peerTaskId: ([^,]+)/.exec(entry)?.[1]))
    .toEqual(["peer?.taskId", "taskId"]);
  const mounts = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "agentsIntegration");
  expect(mounts.map((node) => node.arguments.length)).toEqual([7, 7, 6]);
  const grants = nodes(ts.isBinaryExpression).filter((node) => node.left.getText(source).endsWith(".OMB_OWNER_HOP"));
  expect(grants.map((node) => compact(node.getText(source)))).toEqual(["integrations.agents.env.OMB_OWNER_HOP = key"]);
  const send = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "live.adapter.sendTurn");
  expect(send).toHaveLength(2);
  expect(grants[0].getStart(source)).toBeLessThan(send[0].getStart(source));
  const privatePayload = send[0].arguments[0] as ts.ObjectLiteralExpression;
  expect(privatePayload.properties.map((property) => property.name?.getText(source) ?? property.getText(source))).toEqual([
    "...(trace ? { trace } : {})", "threadId", "text", "model", "effort", "leanStartup", "resumeCursor",
    "resumeFallback", "transcript", "system", "systemUpdate", "approval", "...(readOnly ? { readOnly } : {})", "attended", "integrations", "cwd",
  ]);
  const notes = nodes(ts.isVariableDeclaration).filter((node) => node.initializer && ["turnNotes", "notes", "currentPrompt", "withLate"].includes(node.name.getText(source)))
    .map((node) => compact(node.initializer!.getText(source)))
    .filter((initializer) => /^(?:\[\s*(?:\.\.\.accountNotes|\.\.\.\(importMemory)|\(base: string\) => \[base, \.\.\.late)/.test(initializer));
  expect(notes).toEqual([
    '[ ...(importMemory.offer ? [importOfferNote()] : []), composeUserTurnPrompt(text, turnOpts), ...folded, ].join("\\n\\n")',
    "[...accountNotes, ...paneNotes, ...mailParts.map((part) => part.text), ...routineCards, ...quickAnswers, ...roomEchoes, ...callLines, ...closedAsk, ...syncNotes, ...recallNotes]",
    '(base: string) => [base, ...late, ...(notesNotice ? [notesNotice] : []), ...(memoryNotice ? [memoryNotice] : []), ...(unlandedNotice ? [unlandedNotice] : [])].join("\\n\\n")',
    "[...accountNotes, ...paneNotes, ...mailParts.map((part) => part.text), ...routineCardsSinceLastUserTurn(messages, skipTranscript, task.providerSessionBoundId), ...(replaysTranscript ? [] : quickAnswersSinceLastUserTurn(messages, skipTranscript, task.providerSessionBoundId, threadId)), ...roomEchoesSinceLastUserTurn(messages, skipTranscript, turnOpts.userName, threadId, instance.driverKind, model), ...callLines, ...closedAsk, ...syncNotes, ...recallNotes]",
  ]);
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const boundaries = readdirSync(dir, { recursive: true, encoding: "utf8" }).map((path) => path.replace(/\\/g, "/"))
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !/^(drivers|testing)\//.test(path))
    .map((path) => ({ path, text: readFileSync(join(dir, path), "utf8") }));
  const calls = boundaries.flatMap(({ path, text }) => [...text.matchAll(/\.(sendTurn|steer)\s*\(/g)].map((match) => `${path} ${match[1]}`));
  expect(calls.sort()).toEqual([
    "bot-chat-routes.ts steer", "bot-chat-routes.ts steer", "continuation-turn.ts steer",
    "index.ts sendTurn", "index.ts sendTurn", "note-steer.ts steer", "note-steer.ts steer", "room-steer.ts steer",
  ]);
  const guards = boundaries.flatMap(({ path, text }) => [...text.matchAll(/(?<!function )\bguardPeerTools\(([^)]+)\)/g)].map((match) => `${path} ${match[1]}`));
  expect(guards.sort()).toEqual([
    "bot-chat-routes.ts threadId", "bot-chat-routes.ts threadId", "comms-root.ts threadId", "continuation-turn.ts turn.threadId",
    "index.ts caller.threadId", "index.ts caller.threadId", "index.ts threadId", "internal-routes.ts fromThreadId",
    "internal-routes.ts fromThreadId", "internal-routes.ts threadId", "note-steer.ts threadId", "room-steer.ts threadId",
  ]);
});

it.each([
  ["native replay", { transcript: [{ role: "user", text: "Earlier text" }] }],
  ["provider resume and fallback", { resumeCursor: "existing-cursor" }],
  ["compaction summary", { text: "[Wink durable context summary]\nEarlier conversation" }],
  ["late compaction and system recycle", { systemRecycle: true }],
  ["pending notes and mail", { text: "Note: The export finished.\n\nCurrent message" }],
  ["queued steer folds", { text: "Current message\n\nA folded send" }],
  ["quotes and reactions", { text: "Current message\n\nQuoted conversation" }],
  ["prior provider history", { hasProviderHistory: true }],
  ["task record recovery", { priorTaskPacket: { goal: "Earlier work" } }],
  ["room-linked task", { notOwnerChats: () => new Set(["wink-thread", "evals-thread"]) }],
] as const)("guards %s at either end of the handoff", async (_, context) => {
  privateDispatch("wink", "wink-thread", chatStart(), [ownerLine], context);
  expect(await listedTools(peerDispatch("delegation"))).toEqual(BASE_PEER_TOOLS);
  privateDispatch("wink", "wink-thread", chatStart(), [ownerLine]);
  expect(await listedTools(peerDispatch("delegation", context))).toEqual(BASE_PEER_TOOLS);
});

it.each([true, false])("keeps the next peer guarded after a teammate note steer (taken=%s)", async (taken) => {
  const { rootId } = privateDispatch("wink", "wink-thread", chatStart(), [ownerLine]);
  expect(roots.callerSnapshot("wink", "wink-thread")?.rootId).toBe(rootId);
  await liveSteer(rootId, [report], taken).noteArrived("wink", "wink-thread");
  expect(roots.ownerRoot(rootId)).toBe(false);
  expect(await listedTools(peerDispatch("ask"))).toEqual(BASE_PEER_TOOLS);
});

it("rechecks the tool grant after a steer clears a fresh peer's authority", async () => {
  privateDispatch("wink", "wink-thread", chatStart(), [ownerLine]);
  const env = peerDispatch("ask");
  expect(await listedTools(env)).toHaveLength(20);
  const steer = vi.fn(async () => false);
  await steerUntilTaken({ capabilities: { queueing: true, steerConsumed: true }, steer }, "evals-thread", "Late input.");
  expect(turnRegistry.privatePeerKey("evals", "evals-thread")).toBeUndefined();
  expect(await listedTools(env)).toEqual(BASE_PEER_TOOLS);
  expect((await proxyRequest(env, "tools/call", { name: "propose_routine" })).isError).toBe(true);
  expect(proposal).toBeUndefined();
});

it("keeps both marked and legacy room echoes guarded", async () => {
  expect(await afterRoomEcho(false)).toEqual(BASE_PEER_TOOLS);
  expect(await afterRoomEcho(false, true)).toEqual(BASE_PEER_TOOLS);
  expect(await afterRoomEcho(true)).toEqual(BASE_PEER_TOOLS);
});

it("keeps a scheduled routine's follow-on peer guarded on a private chat", async () => {
  const { rootId } = privateDispatch("wink", "wink-thread", chatStart(), [ownerLine]);
  expect(rootId).not.toBeNull();
  const { opts } = await wakeStart({ id: "scheduled" }, false);
  privateDispatch("wink", "wink-thread", opts!, [ownerLine]);
  const routineRoot = roots.callerSnapshot("wink", "wink-thread")?.rootId;
  expect(roots.reserve(routineRoot, "ask").ok).toBe(true);
  expect(await listedTools(peerDispatch("ask"))).toEqual(BASE_PEER_TOOLS);
});

it("mints an owner origin only for a line the owner's routes mark as theirs", () => {
  expect(roots.ownerRoot(rootFor("wink-thread", { threadId: "wink-thread" }, "unmarked-line"))).toBe(false);
  expect(roots.ownerRoot(rootFor("wink-thread", chatStart(), "owner-line"))).toBe(true);
});

it("marks a line as the owner's only where only the owner reaches", () => {
  const marked = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "startTurn" && /\bowner\b/.test(node.arguments[2]?.getText(source) ?? ""));
  expect(marked.map((node) => compact(node.arguments[2]!.getText(source)))).toEqual([
    "{ threadId, userMessage: userMessage ?? undefined, excludeMessageIds: excludeIds, onDispatchError: rerunIfIdle, owner: true, }",
    "{ threadId, transcriptText: typed, onDispatchError: failed, ...(readOnly ? { readOnly } : {}), owner: !guest }",
    "{ ...opts, owner: true, privateOwner: true }",
  ]);
  expect(["/api/bots/wink/messages", "/api/bots/wink/messages/m1/edit"].map((path) => botRoute(path, "wink"))).toEqual([false, false]);
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
  const callers = (name: string) => files.filter((path) => readFileSync(join(dir, path), "utf8").includes(`${name}(`)).map((path) => path.replace(/\\/g, "/")).sort();
  expect(callers("queueSteeredMessage")).toEqual(["bot-chat-routes.ts", "quick-ask.ts", "steer-queue.ts"]);
  expect(callers("beginPeerUserReply")).toEqual(["bot-chat-routes.ts", "peer-user-reply.ts"]);
  expect(readFileSync(join(dir, "peer-user-reply.ts"), "utf8")).toContain("excludeMessageIds: [message.id], owner: true }");
});
