import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

import { createAccountNotices } from "./account-notice.ts";
import { rootForStart } from "./comms-root.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function section(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`Missing section: ${from}`);
  return source.slice(start, end);
}
function compile(body: string) {
  const javascript = ts.transpileModule(`async function run(scope) { with (scope) { ${body} } }`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(`${javascript}\nreturn run;`)() as (scope: object) => Promise<any>;
}

// The 1:1 and peer turn: notes, the summary rebuild, the dispatch and its accepted-start marks, without booting the server.
const notes = section("  const syncNotes = threadSyncV2", "\n  let turnTranscript");
const rebuild = section("              const notes = [", "\n            }\n            turnTranscript");
const delivery = section("      // a deferred recycle's live session", "\n      store.markReactionsDelivered");
const runTurn = compile(`
  ${notes}
  const first = turnPrompt;
  if (summaryRebuild) { ${rebuild} }
  const started = await dispatch(turnPrompt);
  ${delivery}
  return { first, rebuilt: turnPrompt };`);
const room = section(`    turnRegistry.prepare({ botId: bot.id, threadId, owner: "room", depth: hop`, "\n      .catch((err) => {");
const runRoom = compile(`${room}.catch(() => {});`);

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function changedMain() {
  const notices = createAccountNotices({
    names: { get: () => null, nameOf: (id) => (id === "claude" ? "Claude 1" : "Claude 2") },
    sync: () => {},
    runs: async () => ({ known: true, runs: [{ botId: "atlas", paneId: "p1", label: "ATLAS-1", engine: "claude", accountId: "claude", accountGeneration: 0, state: "busy" }] }),
    schedule: queueMicrotask,
  });
  notices.mainChanged({ base: "claude", engine: "claude", from: { id: "claude", generation: 0 }, to: { id: "acct-2", generation: 1 }, seq: 1 });
  await settle();
  return notices;
}

function turnScope(accountNotices: ReturnType<typeof createAccountNotices>, dispatch: (text: string) => Promise<{ turnId: string }>, summaryRebuild = false) {
  const store = { markPaneNotesDelivered: vi.fn(), activePath: () => [] };
  return {
    accountNotices, dispatch, summaryRebuild, store, bot: { id: "atlas" }, threadId: "t1", threadSyncV2: null,
    paneNotes: ["Pane note: ATLAS-1 finished."], paneNoteIds: [], paneTokens: 0, modelContextWindow: 200_000, newestPaneNoteId: "n1",
    mailForTurn: () => [], routineCards: [], importNotes: [], recallNotes: [], currentPrompt: "hello", messages: [], skipTranscript: new Set(), task: {},
    routineCardsSinceLastUserTurn: () => [], quickAnswers: [], callLines: [], closedAsk: [], quickAnswersSinceLastUserTurn: () => [], roomEchoes: [], roomEchoesSinceLastUserTurn: () => [], turnOpts: {}, replaysTranscript: false, recycleDeferred: false, seed: {}, systemSeed: null,
    markMailRead: vi.fn(), markPaneMailRead: vi.fn(),
  };
}

it("puts the Account note first in the next turn's notes after a committed Main change", async () => {
  const notices = await changedMain();
  const failed = turnScope(notices, () => Promise.reject(new Error("provider unavailable")));
  await expect(runTurn(failed)).rejects.toThrow("provider unavailable");

  const sent: string[] = [];
  const { first, rebuilt } = await runTurn(turnScope(notices, async (text) => { sent.push(text); return { turnId: "turn-1" }; }, true));
  const note = "Account note: Claude Main is now Claude 2 (was Claude 1). Replies already resolved keep their account. Still on Claude 1: ATLAS-1.";
  expect(first).toBe(`${note}\n\nPane note: ATLAS-1 finished.\n\nCurrent message:\n\nhello`);
  expect(rebuilt).toBe(first);
  expect(sent).toEqual([first]);

  const { first: next } = await runTurn(turnScope(notices, async () => ({ turnId: "turn-2" })));
  expect(next).toBe("Pane note: ATLAS-1 finished.\n\nCurrent message:\n\nhello");
});

it("delivers a pending note on a room-member turn", async () => {
  const notices = await changedMain();
  const sent: string[] = [];
  let epoch = 2;
  const scope = {
    accountNotices: notices, bot: { id: "atlas", autoApprove: false, leanStartup: false }, threadId: "room-1", hop: 0, text: "Room message", topics: "", roomSystem: "", cwd: undefined, integrations: {},
    roomMail: [], selection: { instanceId: "claude" }, isCancelled: () => false, epoch: 1, currentTurnEpoch: () => epoch,
    turnRegistry: { prepare: vi.fn() }, verifyDoc: { fixTurn: () => undefined }, workerTurns: { capture: vi.fn() }, pendingInterruptThreads: { started: vi.fn() },
    rootForStart, rootId: null, authority: undefined, lane: false, turnKey: "atlas",
    providerReload: { started: () => ({ adapter: { sendTurn: async (input: { text: string }) => { sent.push(input.text); return { turnId: "room-turn" }; } } }) },
    dispatchAdapterTurn: (_threadId: string, send: () => Promise<unknown>) => Promise.resolve().then(send),
    isUnattended: () => false, memberTurnSelection: () => ({}), bindInterruptedTurn: vi.fn(), markMailRead: vi.fn(),
    store: {}, liveTurnIdByThread: new Map(), reply: { claim: () => false }, finish: vi.fn(), usageStats: { capturing: () => false },
  };
  await runRoom(scope);
  await settle();
  expect(sent).toEqual([]);

  epoch = 1;
  await runRoom(scope);
  await settle();
  expect(sent).toEqual(["Account note: Claude Main is now Claude 2 (was Claude 1). Replies already resolved keep their account. Still on Claude 1: ATLAS-1.\n\nRoom message"]);
  await runRoom(scope);
  await settle();
  expect(sent.at(-1)).toBe("Room message");
});

it("adds no await to the send path", () => {
  const lines = source.split("\n").filter((line) => /accountNote|accountNotices\.|onMainChanged/.test(line));
  expect(lines.filter((line) => line.includes("accountNotices.forTurn("))).toHaveLength(2);
  expect(lines.filter((line) => line.includes("accountNote.commit()"))).toHaveLength(2);
  expect(lines.some((line) => line.includes("accountNotices.mainChanged("))).toBe(true);
  for (const line of lines) expect(line).not.toMatch(/\bawait\b|\.then\(/);
});
