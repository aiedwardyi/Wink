import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import ts from "typescript";

import * as askPrsModule from "./ask-prs.ts";
import { askPr, createAskPrs } from "./ask-prs.ts";
import { asksNudge, type TaskAsk } from "./task-asks.ts";
import { seedTaskResumePacket, stampTaskResumePacket } from "./task-state-fold.ts";
import { taskRecordBlock } from "./turn-context.ts";
import { UNLANDED_REFRESH_MS } from "./unlanded.ts";

const ask = (id: number, overrides: Partial<TaskAsk> = {}): TaskAsk => ({ id: `A${id}`, ask: `ask ${id}`, status: "building", at: 1, changedAt: 1, ...overrides });

function rig(states: Record<string, string>, dir: string | null = "C:/repo") {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  let clock = 1_000;
  const prs = createAskPrs({
    repoDir: () => dir ?? undefined,
    now: () => clock,
    gh: async (cwd, args) => {
      calls.push({ cwd, args });
      const state = states[args[2]!];
      if (!state) throw new Error("no pull requests found");
      return JSON.stringify({ state });
    },
  });
  return { prs, calls, tick: (ms: number) => { clock += ms; } };
}

describe("ask PRs", () => {
  it.each([
    ["PR #1988", { number: 1988 }],
    ["pr 12", { number: 12 }],
    ["https://github.com/AiEdwardYi/Wink/pull/1988", { repo: "aiedwardyi/wink", number: 1988 }],
    ["AiEdwardYi/Wink#2138 merged", { repo: "aiedwardyi/wink", number: 2138 }],
    ["card RELEASE", null],
    [undefined, null],
  ])("reads %j as %j", (ref, pr) => expect(askPr(ref)).toEqual(pr));

  it("closes a building ask once its PR merges, on the turn after the check", async () => {
    const { prs, calls } = rig({ "1988": "MERGED", "7": "OPEN" });
    const asks = [ask(1, { ref: "PR #1988" }), ask(2, { ref: "PR #7" }), ask(3, { status: "open", ref: "PR #1988" }), ask(4, { ref: "card X" })];
    expect(prs.take("bot", "thread", asks)).toEqual([]);
    await prs.settled();
    expect(calls).toEqual([
      { cwd: "C:/repo", args: ["pr", "view", "1988", "--json", "state"] },
      { cwd: "C:/repo", args: ["pr", "view", "7", "--json", "state"] },
    ]);
    expect(prs.take("bot", "thread", asks)).toEqual(["A1"]);
  });

  it("asks gh about a PR URL in its own repo and rechecks an open PR only after the refresh time", async () => {
    const { prs, calls, tick } = rig({ "5": "OPEN" }, null);
    const asks = [ask(1, { ref: "https://github.com/o/r/pull/5" }), ask(2, { ref: "PR #6" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(calls.map((call) => call.args)).toEqual([["pr", "view", "5", "--repo", "o/r", "--json", "state"]]);
    prs.take("bot", "thread", asks);
    tick(UNLANDED_REFRESH_MS - 1);
    prs.take("bot", "thread", asks);
    expect(calls).toHaveLength(1);
    tick(1);
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(calls).toHaveLength(2);
  });

  it("leaves the ask as it is when gh fails", async () => {
    const { prs } = rig({});
    const asks = [ask(1, { ref: "PR #404" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual([]);
  });
});

describe("ask PRs outside a git folder", () => {
  const NOT_REPO = "failed to run git: fatal: not a git repository (or any of the parent directories): .git";
  function desktop(repos: string[]) {
    const prs = createAskPrs({
      repoDir: () => "C:/Users/me/Desktop",
      repos: () => repos,
      gh: async (_cwd, args) => {
        const at = args.indexOf("--repo");
        if (at < 0) throw new Error(NOT_REPO);
        if (args[at + 1] === "aiedwardyi/wink" && args[2] === "2138") return JSON.stringify({ state: "MERGED" });
        throw new Error("no pull requests found");
      },
    } as Parameters<typeof createAskPrs>[0]);
    return prs;
  }

  it("closes a building ask once its PR merges, from a bot folder that is not a git repo", async () => {
    const prs = desktop(["aiedwardyi/wink"]);
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2; ships 1.0.296" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual(["A1014"]);
  });

  it("reports a check it could not run instead of swallowing it", async () => {
    const prs = desktop([]);
    const asks = [ask(914, { ref: "PR 2098 merged; PASSWORD-FILTER-2" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    const failed = (prs as { failed?: (botId: string, threadId: string, asks: readonly TaskAsk[]) => unknown }).failed?.("bot", "thread", asks);
    expect(failed).toEqual([{ id: "A914", reason: expect.stringMatching(/not a git repo/) }]);
  });

  it("checks every known repo and closes when exactly one has the merged PR", async () => {
    const prs = desktop(["aiedwardyi/wink", "aiedwardyi/other"]);
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2; ships 1.0.296" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual(["A1014"]);
  });

  it("keeps the ask open and reported when one of two repos could not be checked", async () => {
    const prs = createAskPrs({
      repoDir: () => "C:/Users/me/Desktop",
      repos: () => ["aiedwardyi/wink", "aiedwardyi/other"],
      gh: async (_cwd, args) => {
        const at = args.indexOf("--repo");
        if (at < 0) throw new Error(NOT_REPO);
        if (args[at + 1] === "aiedwardyi/wink") return JSON.stringify({ state: "MERGED" });
        throw new Error("HTTP 502: Bad Gateway");
      },
    } as Parameters<typeof createAskPrs>[0]);
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2; ships 1.0.296" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual([]);
    const failed = (prs as { failed?: (botId: string, threadId: string, asks: readonly TaskAsk[]) => unknown }).failed?.("bot", "thread", asks);
    expect(failed).toEqual([{ id: "A1014", reason: expect.stringMatching(/502/) }]);
  });

  it("keeps the ask open and reported when two repos both have that PR", async () => {
    const prs = createAskPrs({
      repoDir: () => "C:/Users/me/Desktop",
      repos: () => ["aiedwardyi/wink", "aiedwardyi/other"],
      gh: async (_cwd, args) => {
        if (!args.includes("--repo")) throw new Error(NOT_REPO);
        return JSON.stringify({ state: "MERGED" });
      },
    } as Parameters<typeof createAskPrs>[0]);
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2; ships 1.0.296" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual([]);
    const failed = (prs as { failed?: (botId: string, threadId: string, asks: readonly TaskAsk[]) => unknown }).failed?.("bot", "thread", asks);
    expect(failed).toEqual([{ id: "A1014", reason: expect.stringMatching(/aiedwardyi\/wink.*aiedwardyi\/other/) }]);
  });

  it("counts gh's missing-PR answer as not found and names a dead known repo, redacted and clipped", async () => {
    const key = `ghp_${"a1B2".repeat(9)}`;
    const repos = ["aiedwardyi/wink", "aiedwardyi/other", "aiedwardyi/gone"];
    const prs = createAskPrs({
      repoDir: () => "C:/Users/me/Desktop",
      repos: () => repos,
      gh: async (_cwd, args) => {
        const repo = args[args.indexOf("--repo") + 1];
        if (!args.includes("--repo")) throw new Error(NOT_REPO);
        if (repo === "aiedwardyi/wink") return JSON.stringify({ state: "MERGED" });
        if (repo === "aiedwardyi/other") throw new Error("GraphQL: Could not resolve to a PullRequest with the number of 2138. (repository.pullRequest)");
        throw new Error(`GraphQL: Could not resolve to a Repository with the name 'aiedwardyi/gone'. token ${key} ${"x".repeat(300)}`);
      },
    } as Parameters<typeof createAskPrs>[0]);
    const asks = [ask(1014, { ref: "PR 2138" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks), "a dead repo blocks the close").toEqual([]);
    const failed = (prs as { failed?: (botId: string, threadId: string, asks: readonly TaskAsk[]) => Array<{ id: string; reason: string }> }).failed?.("bot", "thread", asks);
    expect(failed).toEqual([{ id: "A1014", reason: expect.stringMatching(/^aiedwardyi\/gone: GraphQL: Could not resolve to a Repository/) }]);
    expect(failed?.[0]?.reason).not.toContain(key);
    expect(failed?.[0]?.reason.length).toBeLessThan(150);
    repos.pop();
    prs.take("bot", "thread", asks);
    expect(prs.take("bot", "thread", asks), "the other repo's missing PR is not a failure").toEqual(["A1014"]);
  });

  it("tells the bot about a check it could not run on a turn with no ask due a verdict", async () => {
    const prs = desktop([]);
    const asks = [ask(914, { ref: "PR 2098 merged; PASSWORD-FILTER-2" })];
    expect(asksNudge(asks, Date.now(), "ok go")).toBe("");
    prs.take("bot", "thread", asks);
    await prs.settled();
    const failedNote = (prs as { failedNote?: (botId: string, threadId: string, asks: readonly TaskAsk[]) => string }).failedNote;
    const note = failedNote?.("bot", "thread", asks);
    expect(note).toMatch(/A914.*not a git repo/);
    expect(note?.split("\n")).toHaveLength(1);
    expect(failedNote?.("bot", "thread", asks), "once per change").toBe("");
  });

  it("stops rechecking a PR it cannot place until a repo is known", async () => {
    let repos: string[] = [];
    let clock = 1_000;
    let calls = 0;
    const prs = createAskPrs({
      repoDir: () => "C:/Users/me/Desktop",
      repos: () => repos,
      now: () => clock,
      gh: async (_cwd, args) => {
        calls++;
        if (!args.includes("--repo")) throw new Error(NOT_REPO);
        return JSON.stringify({ state: "MERGED" });
      },
    } as Parameters<typeof createAskPrs>[0]);
    const asks = [ask(914, { ref: "PR 2098" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    const first = calls;
    clock += 6 * UNLANDED_REFRESH_MS;
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(calls).toBe(first);
    repos = ["aiedwardyi/wink"];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual(["A914"]);
  });
});

describe("ask PR closes the bot can see", () => {
  it("closes a ref naming two PRs only once both merged", async () => {
    const states: Record<string, string> = { "2150": "MERGED", "2153": "OPEN" };
    const { prs, tick } = rig(states, "D:/wink");
    const asks = [ask(1033, { ref: "PR 2150 + PR 2153" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual([]);
    states["2153"] = "MERGED";
    tick(UNLANDED_REFRESH_MS);
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual(["A1033"]);
  });

  it.each([
    ["PR 2152 merged; real phone test after 1.0.296", "PR 2152 merged", true],
    ["PR 2150 + PR 2153", "PR 2150 and PR 2153 merged", false],
  ])("gives a closed ask one line with its old ref: %s", (ref, merged, stepLeft) => {
    const closedAskLine = (askPrsModule as { closedAskLine?: (ask: TaskAsk) => string }).closedAskLine;
    const line = closedAskLine?.(ask(1035, { ref }));
    expect(line, "closedAskLine").toEqual(expect.stringContaining("A1035"));
    expect(line).toContain(merged);
    expect(line).toContain(ref);
    expect(line?.split("\n")).toHaveLength(1);
    if (stepLeft) expect(line).toMatch(/still open/);
    else expect(line).not.toMatch(/still open/);
  });

  it.each([
    ["A1033", "PR 2150 + PR 2153 f73306e29; gates running; real Mac recheck tomorrow"],
    ["A886", "PR 2089 gate RISK: relay deploy first (needs his deploy word)"],
  ])("says a step may be left whenever the ref says more than its PRs: %s", (_id, ref) => {
    const closedAskLine = (askPrsModule as { closedAskLine?: (ask: TaskAsk) => string }).closedAskLine;
    const line = closedAskLine?.(ask(1, { ref }));
    expect(line, "closedAskLine").toContain(ref);
    expect(line).toMatch(/still open/);
  });

  it("saves a close only once the turn that carried its line lands", async () => {
    const { prs } = rig({ "2138": "MERGED" });
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2; ships 1.0.296" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    const landing = prs as { closing?: (threadId: string, turnId: string, ids: readonly string[]) => void; landed?: (threadId: string, turnId: string, landed: boolean) => string[] };
    landing.closing?.("thread", "t1", prs.take("bot", "thread", asks));
    expect(landing.landed?.("thread", "t1", false), "a turn that never landed").toEqual([]);
    expect(prs.take("bot", "thread", asks), "still pending for the next turn").toEqual(["A1014"]);
    landing.closing?.("thread", "t2", ["A1014"]);
    expect(landing.landed?.("thread", "t2", true)).toEqual(["A1014"]);
  });

  it("never saves a close at turn start, before the turn is sent", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const close = index.slice(index.indexOf("function closeMergedAsks("), index.indexOf("function queueTaskPacket("));
    expect(close).not.toContain("persistTaskPacket(");
  });

  it("rides the closing turn, never a silent close", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const close = index.slice(index.indexOf("function closeMergedAsks("), index.indexOf("function queueTaskPacket("));
    expect(close).toContain("closedAskLine(");
  });
});

describe("repos a bot works in", () => {
  const mod = askPrsModule as {
    reposIn?: (texts: readonly string[]) => string[];
    createKnownRepos?: (deps: { discover: (botId: string) => Promise<string[]> }) => { get(botId: string): string[]; refresh(botId: string): Promise<void> };
  };

  it("reads repos from PR links, owner/repo#n refs and git remotes", () => {
    expect(mod.reposIn?.([
      "https://github.com/AiEdwardYi/Wink/pull/2138",
      "AiEdwardYi/orbit-releases#12 merged",
      "git@github.com:aiedwardyi/quorum.git",
      "https://github.com/aiedwardyi/wink.git",
      "PR 2140",
    ])).toEqual(["aiedwardyi/wink", "aiedwardyi/orbit-releases", "aiedwardyi/quorum"]);
  });

  it("answers take() from a cache filled after a reply settles", async () => {
    let calls = 0;
    const known = mod.createKnownRepos?.({ discover: async () => { calls++; return ["aiedwardyi/wink"]; } });
    expect(known?.get("bot")).toEqual([]);
    expect(calls).toBe(0);
    await known?.refresh("bot");
    expect(known?.get("bot")).toEqual(["aiedwardyi/wink"]);
    known?.get("bot");
    expect(calls).toBe(1);
  });
});

describe("a closing turn in index.ts", () => {
  const index = () => readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  type Landing = {
    closing?: (threadId: string, turnId: string, ids: readonly string[]) => void;
    landed?: (threadId: string, turnId: string, landed: boolean, asks?: readonly TaskAsk[]) => string[];
  };
  const withClosed = (askPrsModule as { withClosed?: (asks: readonly TaskAsk[] | undefined, ids: readonly string[], now: number) => TaskAsk[] }).withClosed;

  it("never closes over the bot's own edit in the closing turn", async () => {
    const { prs } = rig({ "2152": "MERGED" });
    const asks = [ask(1035, { ref: "PR 2152 merged; real phone test after 1.0.296" }), ask(1036, { ref: "PR 2152" }), ask(1037, { ref: "PR 2152" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    const landing = prs as Landing;
    landing.closing?.("thread", "t1", prs.take("bot", "thread", asks));
    const edited = [{ ...asks[0]!, status: "open" as const }, { ...asks[1]!, ref: "PR 2152; phone test left" }, asks[2]!];
    expect(landing.landed?.("thread", "t1", true, edited)).toEqual(["A1037"]);
  });

  it("saves a close in turn.completed once the turn lands, for 1:1 turns and rooms, and marks it at dispatch", () => {
    const source = index();
    const done = source.slice(source.indexOf('    case "turn.completed": {'), source.indexOf("bus.subscribe(observeTraceEvent);"));
    const own = done.indexOf("      if (bot) {");
    const room = done.indexOf("\n      } else {\n", own);
    const speaker = done.indexOf("      const speaker = groupSpeakers.get(event.threadId);");
    expect(own).toBeGreaterThan(0);
    expect(room, "a room turn has no bot here").toBeGreaterThan(own);
    const oneToOne = done.slice(own, room);
    const saved = oneToOne.indexOf("saveLandedCloses(event.threadId, event.turnId, !superseded && !disowned && ");
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBeLessThan(oneToOne.indexOf("if (!superseded && !disowned) {"));
    expect(done.slice(room, speaker)).toContain("saveLandedCloses(event.threadId, event.turnId, ");
    const save = source.slice(source.indexOf("function saveLandedCloses("), source.indexOf("function closeMergedAsks("));
    expect(save).toContain("askPrs.landed(");
    expect(save).toContain("persistTaskPacket(");
    for (const bound of ["bindInterruptedTurn(threadId, started.turnId, bot.id, epoch);", "bindInterruptedTurn(threadId, started.turnId, turnKey, epoch);"]) {
      const at = source.indexOf(bound);
      expect(at, bound).toBeGreaterThan(0);
      expect(source.slice(at, at + 300)).toContain("askPrs.closing(threadId, started.turnId");
    }
  });

  it("puts the close line in every turn note list, rebuilt ones too, and in a room's context", () => {
    const source = index();
    const notes = source.split("\n").filter((line) => /const (turnNotes|notes) = \[\.\.\.accountNotes, \.\.\.paneNotes/.test(line));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("...askNotes,");
    expect(source).toContain("  const askNotes = closes.notes(");
    expect(notes[1]).toContain("...closes.notes(true)");
    const room = source.slice(source.indexOf("  const roomContext = ["), source.indexOf("  stampShownAsks(threadId, roomContext);"));
    expect(room).toContain("...closes.notes(");
  });

  // prepareContext as index.ts runs it, with the store and the summary call stubbed
  function prepareContextIn(scope: Record<string, unknown>) {
    const source = index();
    const start = source.indexOf("  const prepareContext = (");
    const end = source.indexOf("\n  const prepared = nativeReplay ??", start);
    if (start < 0 || end < start) throw new Error("Missing prepareContext");
    const javascript = ts.transpileModule(`function run(scope) { with (scope) {\n${source.slice(start, end)}\n  return prepareContext;\n} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
    return (new Function(`${javascript}\nreturn run;`)() as (scope: Record<string, unknown>) => (messages: unknown[], waitedMs: number) => Promise<unknown>)(scope);
  }

  function closingTurn(selectionChanged: boolean) {
    const stored = { ...seedTaskResumePacket({ botId: "bot", threadId: "thread", text: "ship the close", messageId: "m1", now: 1, turnsAtWrite: 0 }), asks: [ask(1035, { ref: "PR 2152 merged; real phone test after 1.0.296" }), ask(1036, { status: "open", ref: "card X" })] };
    const persisted: Array<{ asks?: TaskAsk[] }> = [];
    const shown = (record: typeof stored | null) => record && { ...record, asks: withClosed?.(record.asks, ["A1035"], 2) ?? record.asks };
    const scope: Record<string, unknown> = {
      threadId: "thread", bot: { id: "bot", threadId: "thread" }, rewound: false, text: "go", opts: {}, unsettled: "", recovering: false, statusTurn: false,
      task: { usage: { turns: 1 }, resumeCursors: {}, reactionsDelivered: undefined }, instanceId: "claude", model: "m", instance: {}, cfg: {}, reactions: {},
      skipTranscript: new Set(), inlineNotes: null, nativeAt: null, planBeforeSummary: undefined, modelContextWindow: 200_000, catalogWindow: 200_000, selectionChanged,
      storedTaskRecord: stored, closes: { ids: ["A1035"], shown, notes: () => [] }, taskRecord: shown(stored), durableTaskRecordText: "", recoveryLatestUserText: "go", sessionPrompt: undefined,
      taskPacketForWrite: () => structuredClone(stored),
      persistTaskPacket: (packet: typeof stored) => { persisted.push(packet); return packet; },
      stampTaskResumePacket, taskRecordBlock,
      lastUserInstruction: () => undefined, sessionPromptFor: () => undefined, store: { messagesFor: () => [] },
      inlineSummarizer: () => undefined, summaryInstance: () => ({}), goalsOf: () => [], logSummaryCall: () => {}, inlineDeadlineMs: () => 0,
      prepareModelContext: async (input: { beforeSummarize?: () => void }) => { input.beforeSummarize?.(); return { status: "ready" }; },
    };
    return { scope, persisted, run: () => prepareContextIn(scope)([], 0) };
  }

  it("keeps a pending close in the list the turn shows after prepareContext reads the store again", async () => {
    const { scope, run } = closingTurn(false);
    await run();
    expect(scope.durableTaskRecordText).toContain("A1036");
    expect(scope.durableTaskRecordText, "the close line says A1035 closed").not.toContain("A1035");
  });

  it.each([[true, "an engine switch"], [false, "a pre-compaction save"]])("never saves a pending close before the turn lands: %s %s", async (selectionChanged) => {
    const { persisted, run } = closingTurn(selectionChanged);
    await run();
    expect(persisted).toHaveLength(selectionChanged ? 2 : 1);
    for (const packet of persisted) expect(packet.asks?.find((item) => item.id === "A1035")?.status).toBe("building");
  });

  it("flushes a room's record from the store copy, never the shown one", () => {
    const source = index();
    expect(source).not.toContain("const taskRecordToFlush = taskRecord;");
    expect(source.split("const taskRecordToFlush = storedTaskRecord;")).toHaveLength(3);
  });
});
