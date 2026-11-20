import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as roots from "./comms-root.ts";
import type { Message } from "./store.ts";

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

afterEach(() => {
  roots._resetCommsRoots();
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

function rootFor(threadId: string, opts: Record<string, unknown>, messageId: string) {
  const root = nodes(ts.isVariableDeclaration).find((node) => node.name.getText(source) === "rootId" && node.initializer?.getText(source).includes("turnStartedByUser(opts)"))!;
  const predicate = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "turnStartedByUser")!;
  return new Function("rootForStart", "threadId", "opts", "commsDepth", "userMessage", js(`${predicate.getText(source)}\nreturn ${root.initializer!.getText(source)};`))(roots.rootForStart, threadId, opts, Number(opts.commsDepth ?? 0), { id: messageId });
}

const hopOptions = {
  ask: (callerRoot: string | null) => new Function("depth", "peer", "fromBotId", "isUnattended", "peerAttribution", "onDispatchError", `return ${js(`(${startTurnOptions("commsRoot: peer?.commsRoot ?? null")})`)}`)(0, { commsRoot: callerRoot }, "wink", () => false, () => ({}), () => {}),
  delegation: (callerRoot: string | null) => new Function("commsDepth", "root", "reservation", "ask", "isUnattended", "sourceBotId", "transcriptText", "peerAttribution", "store", "channel", "reportStartFailure", `return ${js(`(${startTurnOptions("commsRoot: root ?? null")})`)}`)(1, callerRoot ?? undefined, undefined, undefined, () => false, "wink", "", () => ({}), { bot: () => undefined }, undefined, () => {}),
};

function agentsEnv(mountIndex: number, scope: { commsDepth?: number; hop?: number; rootId?: string | null; asked?: string; guestAsked?: boolean; foreign?: boolean }): Record<string, string> {
  const integration = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "agentsIntegration")!;
  const agentsIntegration = new Function("process", "agentsProxyPath", "AGENTS_NODE_FLAG", "PORT", "commsCallers", "teamReports", `${js(integration.getText(source))}; return agentsIntegration;`)(
    { env: {} }, PROXY, {}, 9, { token: () => "fixture-token" }, { prompt: () => "" },
  );
  const mounts = nodes(ts.isIfStatement).filter((node) => node.thenStatement.getText(source).includes("integrations.agents = agentsIntegration("));
  const integrations: { agents?: { env: Record<string, string> } } = {};
  new Function("integrations", "instance", "bot", "threadId", "commsDepth", "hop", "readOnly", "importMemory", "searchable", "works", "handoff", "asked", "guestAsked", "rootId", "ownerRoot", "agentsIntegration", "ownerOrigin", "askOrigin", "lead", "foreign", mounts[mountIndex]!.getText(source))(
    integrations, { adapter: { capabilities: { agentsMcp: true } } }, { id: "evals" }, "evals-thread", scope.commsDepth ?? 0, scope.hop ?? 0, false, { tool: false }, false, true, null, scope.asked, scope.guestAsked ?? false, scope.rootId ?? null, roots.ownerRoot, agentsIntegration,
    roots.ownerOrigin, (ask: { id: string } | null) => (ask ? `ask:${ask.id}` : null), scope.asked ? { id: scope.asked } : null, scope.foreign ?? false,
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
  expect(await peerTools()).toEqual(expect.arrayContaining(["propose_routine", "set_keep_going"]));
  const reply: Message = { id: "guest-reply", at: 1, role: "bot", kind: "activity", comm: { groupId: "dm", withBotId: "guest-bot", withName: "Guest", withColor: "blue", peer: "reply", taskId: "guest-task" } };
  expect(roots.othersInPrompt({ group: () => undefined, row: () => undefined }, "chief-thread", owner, [], [reply])).toBe(true);
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
  const owner = hopOptions.ask(rootFor("wink-thread", { threadId: "wink-thread" }, "owner-line"));
  const ownerEnv = agentsEnv(0, { commsDepth: Number(owner.commsDepth), rootId: fold(rootFor("evals-thread", owner, "owner-peer"), from) });
  expect(await listedTools(ownerEnv)).toEqual(expect.arrayContaining(["propose_routine", "set_keep_going"]));
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

it("reads every prompt for someone else's text before it mounts the tools", () => {
  const checks = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "othersInPrompt");
  expect(checks.map((node) => compact(node.getText(source)))).toEqual([
    "othersInPrompt(store, threadId, rootId, [...paneNoteIds ?? [], ...mailParts.map((part) => part.id), ...carriedEchoes(threadId)])",
    "othersInPrompt(store, threadId, rootId, [...refreshedNotes.ids ?? [], ...carriedEchoes(threadId)])",
    "othersInPrompt(store, threadId, rootId, roomMail.map((part) => part.id), roomRows, group.hosted ? roomHostSeats(group.hosted.roomId) : [])",
  ]);
  const mounts = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "agentsIntegration" && node.arguments.length === 8);
  expect([checks[0]!.getStart(source) < mounts[0]!.getStart(source), checks[1]!.getText(source) && compact(checks[1]!.parent.getText(source)).includes("delete integrations.agents?.env.OMB_OWNER_HOP"), checks[2]!.getStart(source) < mounts[1]!.getStart(source)]).toEqual([true, true, true]);
});

it("opens a peer turn's tools only from an owner origin minted where the owner acted", () => {
  const integration = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "agentsIntegration")!;
  expect(compact(integration.parameters.at(-1)!.getText(source))).toBe("origin: OwnerOrigin | null = null");
  const mounts = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "agentsIntegration");
  expect(mounts.map((node) => compact(node.arguments[7]?.getText(source) ?? "base"))).toEqual([
    "base",
    "commsDepth > 0 ? ownerOrigin(rootId) : null",
    "hop > 0 && !foreign ? (asked ? (guestAsked ? null : askOrigin(lead)) : ownerOrigin(rootId)) : null",
  ]);
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const minted = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
    .flatMap((path) => (readFileSync(join(dir, path), "utf8").match(/\bas (unknown as )?OwnerOrigin\b/g) ?? []).map(() => path.replace(/\\/g, "/")));
  expect(minted.sort()).toEqual(["comms-root.ts", "rooms/asks.ts"]);
  const owner = roots.rootForStart("wink-thread", { kind: "human", messageKey: "owner-line" });
  expect(roots.ownerOrigin(roots.rootForStart("evals-thread", { kind: "inherit", rootId: owner }))).toBe(owner);
  const starts = [roots.rootForStart("wink-thread", { kind: "automatic" }), roots.rootForStart("joined-thread", { kind: "guest", messageKey: "guest-line" }), roots.adoptHumanRoot("idle-thread", "owner-steer", null)];
  expect(starts.map((rootId) => roots.ownerOrigin(rootId))).toEqual([null, null, null]);
});
