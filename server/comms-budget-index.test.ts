import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { _resetCommsRoots, commit, release, reserve, ROOT_TURNS, rootForStart, type Reservation } from "./comms-root.ts";
import { traceClaimedTurn } from "./turn-timing.ts";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const compact = (text: string) => text.replace(/\s+/g, " ").trim();
const nodes = <T extends ts.Node>(guard: (node: ts.Node) => node is T, root: ts.Node = source): T[] => {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};
const fn = (name: string) => nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === name)!;
const js = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

afterEach(() => _resetCommsRoots());

function spentRoot(left: number) {
  const rootId = rootForStart("budget-index-thread", { kind: "human", messageKey: "send-1" })!;
  for (let index = left; index < ROOT_TURNS; index++) commit((reserve(rootId, "ask") as { reservation: Reservation }).reservation);
  return rootId;
}

it("commits a reservation right on the accepted dispatch result, with no await between", () => {
  const commits = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "commit");
  expect(commits).toHaveLength(1);
  const statement = commits[0].parent.parent as ts.Statement;
  expect(compact(statement.getText(source))).toBe("if (reservation) commit(reservation);");
  const block = statement.parent as ts.Block;
  const index = block.statements.indexOf(statement);
  // only the synchronous interrupt binding sits between the accepted start and the commit
  expect(compact(block.statements[index - 1]!.getText(source))).toBe("bindInterruptedTurn(threadId, started.turnId, bot.id, epoch);");
  expect(compact(block.statements[index - 2]!.getText(source))).toMatch(/^const started = await dispatchAdapterTurn\(threadId, /);
  let owner: ts.Node = statement;
  while (!ts.isFunctionDeclaration(owner)) owner = owner.parent;
  expect(owner.name?.text).toBe("startClaimedTurn");
});

it("settles the dispatch's reservation once the dispatch ends, committed or not", () => {
  const body = fn("startClaimedTurn").body!.getText(source);
  expect(compact(body)).toContain("const reservation = opts?.reservation; if (reservation) dispatchingReservations.add(reservation); void (async () => {");
  expect(compact(body)).toContain("})().finally(() => { if (!reservation) return; dispatchingReservations.delete(reservation); release(reservation); });");
});

it("releases a start's credit on a busy rejection and a failure before dispatch, but leaves a dispatching one alone", async () => {
  const rootId = spentRoot(2);
  const startTurn = new Function("deps", `const { tryClaimTurnStart, busyRejection, startClaimedTurn, traceClaimedTurn, release, dispatchingReservations, takeStartingHold, turnStartClaims, store, continueQueuedDrainIfIdle, botHasActiveTurn, drainQueuedSends, paneWake } = deps;\n${js(fn("startTurn").getText(source))}\nreturn startTurn;`);
  const dispatchingReservations = new Set<Reservation>();
  let claim = false;
  let claimed: (reservation?: Reservation) => Promise<unknown> = async () => undefined;
  const run = startTurn({
    tryClaimTurnStart: () => claim, busyRejection: (message: string) => Object.assign(new Error(message), { busy: true }),
    startClaimedTurn: (_botId: string, _text: string, opts?: { reservation?: Reservation }) => claimed(opts?.reservation),
    takeStartingHold: () => () => {},
    traceClaimedTurn, release, dispatchingReservations, turnStartClaims: new Set(), store: { bot: () => undefined }, continueQueuedDrainIfIdle: () => {},
  }) as (botId: string, text: string, opts?: { threadId?: string; reservation?: Reservation }) => Promise<unknown>;
  const take = () => (reserve(rootId, "wake") as { reservation: Reservation }).reservation;

  await expect(run("bot", "wake", { threadId: "t", reservation: take() })).rejects.toMatchObject({ busy: true });
  claim = true;
  claimed = async () => { throw new Error("provider unavailable"); };
  await expect(run("bot", "wake", { threadId: "t", reservation: take() })).rejects.toThrow("provider unavailable");
  const first = take();
  const second = take();
  expect(reserve(rootId, "wake")).toEqual({ ok: false, reason: "reserved" });
  claimed = async (reservation) => { if (reservation) dispatchingReservations.add(reservation); };
  await run("bot", "wake", { threadId: "t", reservation: first });
  expect(reserve(rootId, "wake")).toEqual({ ok: false, reason: "reserved" });
  commit(first);
  release(second);
  release(first);
  expect(reserve(rootId, "wake").ok).toBe(true);
  expect(reserve(rootId, "wake")).toEqual({ ok: false, reason: "reserved" });
});

it("hands the wake's own admission to startTurn and re-arms a busy wake", async () => {
  const scheduler = nodes(ts.isNewExpression).find((node) => node.expression.getText(source) === "PaneWakeScheduler")!;
  const options = scheduler.arguments![0] as ts.ObjectLiteralExpression;
  const property = (name: string) => options.properties.find((prop) => prop.name?.getText(source) === name) as ts.PropertyAssignment;
  expect(compact(property("admit").initializer.getText(source))).toBe("(botId, threadId) => admitPaneWake(store, botId, threadId, commsBus.replyUnwoken)");
  const startTurn = vi.fn(async (..._args: unknown[]) => undefined);
  const noteArrived = vi.fn();
  const wake = new Function("startTurn", "PANE_WAKE_PROMPT", "paneWake", "isBusyRejection", "console", "teamSnags",
    `return ${js(property("wake").initializer.getText(source))}`)(startTurn, "wake prompt", { noteArrived }, (error: { busy?: boolean }) => error.busy === true, console, undefined);
  const reservation: Reservation = { id: "credit", rootId: "root-a", kind: "wake" };
  wake("bot", "t", { rootId: "root-a", reservation });
  wake("bot", "t", { rootId: null, reservation: null });
  expect(startTurn.mock.calls.map((call) => call[2])).toEqual([
    { threadId: "t", cardContinuation: true, paneNoteWake: true, commsRoot: "root-a", reservation },
    { threadId: "t", cardContinuation: true, paneNoteWake: true },
  ]);
  startTurn.mockRejectedValueOnce(Object.assign(new Error("busy"), { busy: true }));
  wake("bot", "t", { rootId: "root-a", reservation });
  await vi.waitFor(() => expect(noteArrived).toHaveBeenCalledExactlyOnceWith("bot", "t"));
});

it("passes the reservation from the ask and delegation seams to startTurn", () => {
  const calls = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "startTurn");
  const optionsOf = (call: string) => calls.filter((node) => node.arguments.slice(0, 2).map((arg) => compact(arg.getText(source))).join(", ") === call)
    .map((node) => compact(node.arguments[2]!.getText(source)));
  expect(optionsOf("targetBotId, message")).toEqual([expect.stringContaining("reservation: peer?.reservation,")]);
  expect(optionsOf("toBotId, text")).toEqual([expect.stringContaining("reservation, commsAsk: ask,")]);
  expect(calls.filter((node) => node.arguments[2] && /reservation/.test(node.arguments[2].getText(source)))).toHaveLength(2);
  expect(source.text).not.toMatch(/clearAskBudget|clearDelegationWakeBudget|claimDelegationWake/);
});
