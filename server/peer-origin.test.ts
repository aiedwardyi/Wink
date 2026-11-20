import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import * as roots from "./comms-root.ts";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const PROXY = fileURLToPath(new URL("./drivers/agents-proxy.ts", import.meta.url));
const BASE_PEER_TOOLS = ["check_delegation", "list_bots", "list_routines", "update_task_state", "wait_delegation"];
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

afterEach(() => roots._resetCommsRoots());

const startTurnOptions = (marker: string) => nodes(ts.isCallExpression)
  .find((node) => node.expression.getText(source) === "startTurn" && compact(node.arguments[2]?.getText(source) ?? "").includes(marker))!
  .arguments[2]!.getText(source);

function joinedStart(guest: boolean) {
  const arrow = nodes(ts.isPropertyAssignment).find((node) => node.name.getText(source) === "startTurn" && node.initializer.getText(source).includes("transcriptText: typed"))!.initializer.getText(source);
  let captured: Record<string, unknown> = {};
  new Function("startTurn", "joinedRoomThreads", `return ${js(arrow)}`)((_botId: string, _prompt: string, opts: Record<string, unknown>) => { captured = opts; }, new Set())("bot", "joined-thread", "prompt", "typed", () => {}, false, guest);
  return captured;
}

function rootFor(threadId: string, opts: Record<string, unknown>, messageId: string) {
  const root = nodes(ts.isVariableDeclaration).find((node) => node.name.getText(source) === "rootId" && node.initializer?.getText(source).includes("turnStartedByUser(opts)"))!;
  const predicate = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "turnStartedByUser")!;
  return new Function("rootForStart", "threadId", "opts", "commsDepth", "userMessage", js(`${predicate.getText(source)}\nreturn ${root.initializer!.getText(source)};`))(roots.rootForStart, threadId, opts, Number(opts.commsDepth ?? 0), { id: messageId });
}

const hopOptions = {
  ask: (callerRoot: string | null) => new Function("depth", "peer", "fromBotId", "isUnattended", "peerAttribution", "onDispatchError", `return ${js(`(${startTurnOptions("commsRoot: peer?.commsRoot ?? null")})`)}`)(0, { commsRoot: callerRoot }, "wink", () => false, () => ({}), () => {}),
  delegation: (callerRoot: string | null) => new Function("commsDepth", "root", "reservation", "ask", "isUnattended", "sourceBotId", "transcriptText", "peerAttribution", "store", "channel", "reportStartFailure", `return ${js(`(${startTurnOptions("commsRoot: root ?? null")})`)}`)(1, callerRoot ?? undefined, undefined, undefined, () => false, "wink", "", () => ({}), { bot: () => undefined }, undefined, () => {}),
};

function agentsEnv(mountIndex: number, scope: { commsDepth?: number; hop?: number; rootId?: string | null; asked?: string; guestAsked?: boolean }): Record<string, string> {
  const integration = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "agentsIntegration")!;
  const agentsIntegration = new Function("process", "agentsProxyPath", "AGENTS_NODE_FLAG", "PORT", "commsCallers", "teamReports", `${js(integration.getText(source))}; return agentsIntegration;`)(
    { env: {} }, PROXY, {}, 9, { token: () => "fixture-token" }, { prompt: () => "" },
  );
  const mounts = nodes(ts.isIfStatement).filter((node) => node.thenStatement.getText(source).includes("integrations.agents = agentsIntegration("));
  const integrations: { agents?: { env: Record<string, string> } } = {};
  new Function("integrations", "instance", "bot", "threadId", "commsDepth", "hop", "readOnly", "importMemory", "searchable", "works", "handoff", "asked", "guestAsked", "rootId", "ownerRoot", "agentsIntegration", mounts[mountIndex]!.getText(source))(
    integrations, { adapter: { capabilities: { agentsMcp: true } } }, { id: "evals" }, "evals-thread", scope.commsDepth ?? 0, scope.hop ?? 0, false, { tool: false }, false, true, null, scope.asked, scope.guestAsked ?? false, scope.rootId ?? null, roots.ownerRoot, agentsIntegration,
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

function fold(rootId: string | null, from: "activePath" | "pathTail") {
  const loop = nodes(ts.isForOfStatement).find((node) => node.getText(source).includes(`store.${from}(threadId`) && node.getText(source).includes("adoptHumanRoot"))!;
  const store = { activePath: () => [{ id: "owner-steer" }], pathTail: () => [{ id: "owner-steer" }] };
  return new Function("store", "threadId", "folded", "queued", "adoptHumanRoot", "rootId", `${js(loop.getText(source))}\nreturn rootId;`)(store, "evals-thread", ["steer"], ["steer"], roots.adoptHumanRoot, rootId) as string | null;
}

function listedTools(env: Record<string, string>): Promise<string[]> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
  const proxy = spawn(process.execPath, [PROXY], { windowsHide: true, env: { ...inherited, ...env, OMB_HARNESS_URL: "http://127.0.0.1:9" }, stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proxy.kill(); reject(new Error("proxy probe timed out")); }, 10_000);
    let buf = "";
    proxy.stdout!.on("data", (chunk) => {
      buf += chunk;
      const line = buf.split("\n").find((row) => row.trim());
      if (!line || !buf.includes("\n")) return;
      clearTimeout(timer);
      proxy.kill();
      resolve(JSON.parse(line).result.tools.map((tool: { name: string }) => tool.name).sort());
    });
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  });
}

it.each(["ask", "delegation"] as const)("gives a %s a joined room's other person started only the base peer tools", async (kind) => {
  const callerRoot = rootFor("joined-thread", joinedStart(true), "guest-line");
  expect(callerRoot).not.toBeNull();
  const opts = hopOptions[kind](callerRoot);
  const env = agentsEnv(0, { commsDepth: Number(opts.commsDepth), rootId: rootFor("evals-thread", opts, "peer-line") });
  expect(await listedTools(env)).toEqual(BASE_PEER_TOOLS);
});

it.each(["ask", "delegation"] as const)("keeps the opened tools on a %s the owner started, here or in a joined room", async (kind) => {
  for (const start of [{ threadId: "wink-thread", opts: { threadId: "wink-thread" } }, { threadId: "joined-thread", opts: joinedStart(false) }]) {
    const opts = hopOptions[kind](rootFor(start.threadId, start.opts, `${start.threadId}-line`));
    const tools = await listedTools(agentsEnv(0, { commsDepth: Number(opts.commsDepth), rootId: rootFor("evals-thread", opts, "peer-line") }));
    expect(tools).toEqual(expect.arrayContaining(["propose_routine", "propose_routine_action", "set_keep_going"]));
    expect(tools).not.toContain("delegate_bot");
  }
});

it("gives a room hop a guest's ask started only the base peer tools", async () => {
  expect(await listedTools(agentsEnv(1, { hop: 1, asked: "ask-1", guestAsked: true }))).toEqual(BASE_PEER_TOOLS);
  expect(await listedTools(agentsEnv(1, { hop: 1, asked: "ask-1", guestAsked: false }))).toEqual(expect.arrayContaining(["propose_routine", "set_keep_going"]));
  const ownerLine = roots.rootForStart("room-thread", { kind: "human", messageKey: "owner-line" });
  expect(await listedTools(agentsEnv(1, { hop: 1, rootId: ownerLine }))).toEqual(expect.arrayContaining(["propose_routine", "set_keep_going"]));
  expect(await listedTools(agentsEnv(1, { hop: 1 }))).toEqual(BASE_PEER_TOOLS);
});

it("gives the next room speaker after a wake no owner turn set only the base peer tools", async () => {
  roots.rootForStart("wink-thread", { kind: "human", messageKey: "owner-line" });
  const owner = await wakeStart({ id: "owner-wake", wake: true, ownerChain: true }, true);
  expect(await listedTools(agentsEnv(1, { hop: 1, rootId: owner.rootId }))).toEqual(expect.arrayContaining(["propose_routine", "set_keep_going"]));
  const guest = await wakeStart({ id: "guest-wake", wake: true }, true);
  expect(await listedTools(agentsEnv(1, { hop: 1, rootId: guest.rootId }))).toEqual(BASE_PEER_TOOLS);
});

it("gives a hop from a private wake no owner turn set only the base peer tools", async () => {
  roots.rootForStart("wink-thread", { kind: "human", messageKey: "owner-line" });
  const { opts } = await wakeStart({ id: "guest-wake", wake: true }, false);
  const hop = hopOptions.ask(rootFor("wink-thread", opts!, "wake-line"));
  expect(await listedTools(agentsEnv(0, { commsDepth: Number(hop.commsDepth), rootId: rootFor("evals-thread", hop, "peer-line") }))).toEqual(BASE_PEER_TOOLS);
});

it.each(["activePath", "pathTail"] as const)("never upgrades a guest-started peer an owner steer folds into (%s)", async (from) => {
  const guest = hopOptions.ask(rootFor("joined-thread", joinedStart(true), "guest-line"));
  const guestEnv = agentsEnv(0, { commsDepth: Number(guest.commsDepth), rootId: fold(rootFor("evals-thread", guest, "guest-peer"), from) });
  expect(await listedTools(guestEnv)).toEqual(BASE_PEER_TOOLS);
  const owner = hopOptions.ask(rootFor("wink-thread", { threadId: "wink-thread" }, "owner-line"));
  const ownerEnv = agentsEnv(0, { commsDepth: Number(owner.commsDepth), rootId: fold(rootFor("evals-thread", owner, "owner-peer"), from) });
  expect(await listedTools(ownerEnv)).toEqual(expect.arrayContaining(["propose_routine", "set_keep_going"]));
});
