import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import ts from "typescript";

import * as askPrsModule from "./ask-prs.ts";
import { askPr, createAskPrs } from "./ask-prs.ts";
import { asksNudge, mergeTaskAsks, type TaskAsk } from "./task-asks.ts";
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
      { cwd: "C:/repo", args: ["pr", "view", "1988", "--json", "state,mergedAt"] },
      { cwd: "C:/repo", args: ["pr", "view", "7", "--json", "state,mergedAt"] },
    ]);
    expect(prs.take("bot", "thread", asks)).toEqual(["A1"]);
  });

  it("asks gh about a PR URL in its own repo and rechecks an open PR only after the refresh time", async () => {
    const { prs, calls, tick } = rig({ "5": "OPEN" }, null);
    const asks = [ask(1, { ref: "https://github.com/o/r/pull/5" }), ask(2, { ref: "PR #6" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(calls.map((call) => call.args)).toEqual([["pr", "view", "5", "--repo", "o/r", "--json", "state,mergedAt"]]);
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
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2" })];
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
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2" })];
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
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2" })];
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
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2" })];
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

  it.each(["aiedwardyi/wink#999999", "https://github.com/aiedwardyi/wink/pull/999999"])("tells the bot a PR %s names with its repo is not found", async (ref) => {
    const { prs } = rig({});
    const asks = [ask(1, { ref })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual([]);
    expect(prs.failed("bot", "thread", asks)).toEqual([{ id: "A1", reason: expect.stringContaining("aiedwardyi/wink#999999") }]);
    expect(prs.failedNote("bot", "thread", asks)).toContain("A1");
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
    ["PR 2150 + PR 2153", "PR 2150 and PR 2153 merged"],
    ["PR 2152 MERGED 46e6705b6", "PR 2152 merged"],
  ])("gives a closed ask one line with its old ref: %s", (ref, merged) => {
    const line = askPrsModule.closedAskLine(ask(1035, { ref }));
    expect(line).toContain("Wink closed A1035");
    expect(line).toContain(merged);
    expect(line).toContain(ref);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toMatch(/step left/);
  });

  it.each([
    ["PR 2152 MERGED 46e6705b6; real phone test after 1.0.296", "PR 2152 merged; step left: real phone test after 1.0.296"],
    ["PR 2150 + PR 2153 f73306e29; gates running; real Mac recheck tomorrow", "PR 2150 and PR 2153 merged; step left: gates running; real Mac recheck tomorrow"],
    ["PR 2098 merged; PASSWORD-FILTER-2", "PR 2098 merged; step left: PASSWORD-FILTER-2"],
    ["PR 2089 gate RISK: relay deploy first (needs his deploy word)", "PR 2089 merged; step left: gate RISK: relay deploy first (needs his deploy word)"],
  ])("keeps an ask building and names the step its ref still holds: %s", (ref, said) => {
    const line = askPrsModule.closedAskLine(ask(1, { ref }));
    expect(line).toContain("Wink kept A1");
    expect(line).toContain(said);
    expect(line).not.toMatch(/closed/);
  });

  it("saves a close only once the turn that carried its line lands", async () => {
    const { prs } = rig({ "2138": "MERGED" });
    const asks = [ask(1014, { ref: "PR 2138 merged b3cb094a2" })];
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
    expect(close).toContain("askPrs.stepNote(");
  });
});

describe("repos a bot works in", () => {
  const mod = askPrsModule as {
    reposIn?: (texts: readonly string[]) => string[];
    remoteRepo?: (url: string) => string | undefined;
    createKnownRepos?: (deps: { discover: (botId: string) => Promise<string[]>; cited: (botId: string) => Promise<string[]>; saved: (botId: string) => readonly string[]; save: (botId: string, repos: string[]) => void }) => { get(botId: string): string[] | undefined; cite(botId: string): Promise<void>; refresh(botId: string): Promise<void> };
  };

  it("reads repos from PR links, owner/repo#n refs and git remotes", () => {
    expect(mod.reposIn?.(["https://github.com/AiEdwardYi/Wink/pull/2138", "AiEdwardYi/orbit-releases#12 merged", "PR 2140"])).toEqual(["aiedwardyi/wink", "aiedwardyi/orbit-releases"]);
    expect(["git@github.com:aiedwardyi/quorum.git\n", "https://github.com/AiEdwardYi/Wink.git\n", "https://gitlab.com/o/r.git"].map((url) => mod.remoteRepo?.(url))).toEqual(["aiedwardyi/quorum", "aiedwardyi/wink", undefined]);
  });

  it("answers take() from a cache filled after a reply settles", async () => {
    let calls = 0;
    const saved = new Map<string, string[]>();
    const known = mod.createKnownRepos?.({ discover: async () => { calls++; return ["aiedwardyi/wink"]; }, cited: async () => [], saved: (botId) => saved.get(botId) ?? [], save: (botId, repos) => saved.set(botId, repos) });
    expect(known?.get("bot")).toBeUndefined();
    expect(calls).toBe(0);
    await known?.refresh("bot");
    expect(known?.get("bot")).toEqual(["aiedwardyi/wink"]);
    known?.get("bot");
    expect(calls).toBe(1);
  });

  it("reads no repo from a plain github.com link a report cites", () => {
    expect(mod.reposIn?.(["LENS-VOICE: followed https://github.com/meta/meta-wearables-webapp/blob/main/AGENTS.md", "see github.com/o/r"])).toEqual([]);
  });

  it("learns repos into the bot record, reading pane remotes apart from report text, and keeps them off the wire", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(source).toContain("createKnownRepos({ saved: (botId) => store.bot(botId)?.knownRepos ?? [], save: (botId, repos) => store.rememberRepos(botId, repos),");
    expect(source).toContain("  return remotes.flatMap((url) => remoteRepo(url) ?? []);\n}, cited: async (botId, boot) => {\n");
    expect(source).toContain("  return reposIn([...botAsks(bot, (threadId) => store.taskPacket(threadId), notOwnerChats()).map((ask) => ask.ref ?? \"\"), ...reports]);\n} });");
    expect(source).toContain("    knownRepos: _knownRepos,\n");
    const unlanded = source.slice(source.indexOf('startupTiming.afterPaint("unlanded"'), source.indexOf("const memoryLookup = createMemoryLookup("));
    expect(unlanded, "a restart reads the cited repos off the send path, from boot's reports").toContain("  for (const bot of store.bots) await knownRepos.cite(bot.id, store.loaded(bot.threadId) ? undefined : boot.get(bot.threadId));\n");
  });

  describe("a bare PR from a bot folder that is not a repo", () => {
    const META = "meta/meta-wearables-webapp";
    const WINK = "aiedwardyi/wink";
    function bot(found: string[][], saved: Map<string, string[]>, cited: string[][] = [], held: Record<string, string> = {}) {
      const known = mod.createKnownRepos!({ discover: async () => found.shift() ?? [], cited: async () => cited.shift() ?? [], saved: (botId) => saved.get(botId) ?? [], save: (botId, repos) => saved.set(botId, repos) });
      const prs = createAskPrs({
        repoDir: () => "C:/Users/me/Desktop",
        repos: known.get,
        gh: async (_cwd, args) => {
          if (args[1] === "view" && !args.includes("--repo")) throw new Error("failed to run git: fatal: not a git repository (or any of the parent directories): .git");
          const state = ({ [`${WINK}|2161`]: "MERGED", ...held } as Record<string, string>)[`${args[args.indexOf("--repo") + 1]}|${args[2]}`];
          if (!state) throw new Error("GraphQL: Could not resolve to a PullRequest with the number of 2161. (repository.pullRequest)");
          return JSON.stringify({ state });
        },
      });
      return { known, prs };
    }
    const asks = [ask(1057, { ref: "PR 2161 merged 8e3752db8" })];
    const check = async ({ prs }: ReturnType<typeof bot>) => {
      prs.take("bot", "thread", asks);
      await prs.settled();
      prs.take("bot", "thread", asks);
      await prs.settled();
      return { taken: prs.take("bot", "thread", asks), failed: prs.failedNote("bot", "thread", asks, true) };
    };

    it("keeps a repo a pane remote taught it after a refresh that found less", async () => {
      const saved = new Map<string, string[]>();
      const live = bot([[META, WINK], [META]], saved);
      await live.known.refresh("bot");
      await live.known.refresh("bot");
      expect(await check(live)).toEqual({ taken: ["A1057"], failed: "" });
    });

    it("keeps that repo across a restart with no panes open", async () => {
      const saved = new Map<string, string[]>();
      await bot([[WINK]], saved).known.refresh("bot");
      const restarted = bot([[]], saved);
      await restarted.known.refresh("bot");
      expect(await check(restarted)).toEqual({ taken: ["A1057"], failed: "" });
    });

    it("looks it up in a repo a report cites only while that report is in the window", async () => {
      const saved = new Map<string, string[]>();
      const live = bot([[WINK], []], saved, [["x/y"], []], { "x/y|2161": "OPEN" });
      await live.known.refresh("bot");
      expect(await check(live)).toEqual({ taken: [], failed: expect.stringContaining("PR 2161 is in aiedwardyi/wink and x/y") });
      await live.known.refresh("bot");
      expect(await check(live)).toEqual({ taken: ["A1057"], failed: "" });
      expect(saved.get("bot")).toEqual([WINK]);
    });

    it("holds it after a restart until the repos its reports cite are read", async () => {
      const restarted = bot([], new Map([["bot", [WINK]]]), [["x/y"]], { "x/y|2161": "OPEN" });
      expect(await check(restarted), "a send before the first refresh").toEqual({ taken: [], failed: "" });
      await restarted.known.cite("bot");
      expect(await check(restarted)).toEqual({ taken: [], failed: expect.stringContaining("PR 2161 is in aiedwardyi/wink and x/y") });
    });

    it("closes it on the first turn after a restart once no report cites another repo", async () => {
      const restarted = bot([], new Map([["bot", [WINK]]]));
      await restarted.known.cite("bot");
      expect(await check(restarted)).toEqual({ taken: ["A1057"], failed: "" });
    });

    it("keeps the cited repos it last read when reading them fails", async () => {
      let fail = false;
      const known = mod.createKnownRepos!({ discover: async () => [], cited: async () => { if (fail) throw new Error("database is locked"); return ["x/y"]; }, saved: () => [WINK], save: () => {} });
      fail = true;
      await known.refresh("bot");
      expect(known.get("bot"), "never read").toBeUndefined();
      fail = false;
      await known.refresh("bot");
      fail = true;
      await known.refresh("bot");
      expect(known.get("bot")).toEqual([WINK, "x/y"]);
    });

    it("saves only when a refresh found a remote it did not have", async () => {
      const saved = new Map([["bot", [WINK]]]);
      const saves: string[][] = [];
      const found = [[WINK], [META]];
      const known = mod.createKnownRepos!({ discover: async () => found.shift()!, cited: async () => [], saved: (botId) => saved.get(botId) ?? [], save: (botId, repos) => { saves.push(repos); saved.set(botId, repos); } });
      await known.refresh("bot");
      expect(saves).toEqual([]);
      await known.refresh("bot");
      expect(saves).toEqual([[WINK, META]]);
    });

    it("reads the cited repos when finding pane remotes throws", async () => {
      const known = mod.createKnownRepos!({ discover: async () => { throw new Error("terminal bridge down"); }, cited: async () => ["x/y"], saved: () => [WINK], save: () => {} });
      await known.refresh("bot");
      expect(known.get("bot")).toEqual([WINK, "x/y"]);
    });

    it("keeps a remote an overlapping refresh saved while a slower one found less", async () => {
      const saved = new Map<string, string[]>();
      let slow!: (repos: string[]) => void;
      const found = [new Promise<string[]>((resolve) => { slow = resolve; }), Promise.resolve([META, WINK])];
      const known = mod.createKnownRepos!({ discover: () => found.shift()!, cited: async () => [], saved: (botId) => saved.get(botId) ?? [], save: (botId, repos) => saved.set(botId, repos) });
      const first = known.refresh("bot");
      await known.refresh("bot");
      slow([META]);
      await first;
      expect(saved.get("bot")).toEqual([META, WINK]);
    });
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
    const edited = [{ ...asks[0]!, status: "open" as const, changedAt: 2 }, { ...asks[1]!, ref: "PR 2152; phone test left", changedAt: 2 }, asks[2]!];
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
    expect(done.slice(speaker, done.indexOf("roomLanes.settle(event.threadId);", speaker)), "a room-only bot learns its repos too").toContain("void knownRepos.refresh(speaker.botId);");
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
      lastUserInstruction: () => undefined, sessionPromptFor: () => undefined, store: { messagesFor: () => [] }, taskRows: (rows: unknown[]) => rows,
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

  it("stamps a 1:1 turn's leftovers shown only once an engine took the prompt, so a setup failure leaves them for the retry", () => {
    const source = index();
    const stamp = source.indexOf("  stampShownAsks(threadId, turnText);");
    expect(source.split("stampShownAsks(threadId, turnText);")).toHaveLength(2);
    expect(stamp).toBeGreaterThan(source.indexOf("return live.adapter.sendTurn({"));
    expect(source.lastIndexOf("store.markReactionsDelivered(bot.id, threadId, reactionsSeen);", stamp)).toBeGreaterThan(source.indexOf("return live.adapter.sendTurn({"));
  });

  it("keeps the last turn's held question until an engine accepted the next prompt, so a failed start, even a late one, still carries it to a switch", () => {
    const source = index();
    const start = source.slice(source.indexOf("async function startClaimedTurn("), source.indexOf("async function startClaimedTurn(") + 60_000);
    expect(start).toContain("heldQuestions.get(threadId)");
    expect(start).not.toContain("heldQuestions.delete");
    const settle = source.slice(source.indexOf('case "turn.completed": {'));
    expect(settle).toContain("if (!superseded && !disowned && (event.promptAccepted || event.ok && !interrupted)) heldQuestions.delete(event.threadId);");
  });
});

describe("an ask with a step left", () => {
  it("stays open after its PRs merge and the turn lands", async () => {
    const { prs } = rig({ "2152": "MERGED" });
    const asks = [ask(1035, { ref: "PR 2152 MERGED 46e6705b6; real phone test after 1.0.296" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    prs.closing("thread", "t1", prs.take("bot", "thread", asks));
    expect(prs.landed("thread", "t1", true, asks)).toEqual([]);
  });

  it("tells the bot once that its PRs merged and which step is left, again after a turn that never landed", async () => {
    const { prs } = rig({ "2152": "MERGED" });
    const asks = [ask(1035, { ref: "PR 2152 MERGED 46e6705b6; real phone test after 1.0.296" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.stepNote("bot", "thread", asks)).toContain("PR 2152 merged; step left: real phone test after 1.0.296");
    expect(prs.stepNote("bot", "thread", asks), "once per change").toBe("");
    expect(prs.stepNote("bot", "thread", asks, true), "a new session hears it").toContain("A1035");
    prs.closing("thread", "t1", []);
    prs.landed("thread", "t1", false);
    expect(prs.stepNote("bot", "thread", asks)).toContain("A1035");
  });

  it.each([
    "https://github.com/aiedwardyi/Wink/pull/2152",
    "https://www.github.com/aiedwardyi/Wink/pull/2152",
    "https://github.com/aiedwardyi/Wink/pull/2152/files",
    "http://github.com/aiedwardyi/Wink/pull/2152 merged",
  ])("closes a ref written as the PR link %s once it merges, with no step left", async (ref) => {
    const { prs } = rig({ "2152": "MERGED" });
    const asks = [ask(1035, { ref })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    prs.closing("thread", "t1", prs.take("bot", "thread", asks));
    expect(prs.stepNote("bot", "thread", asks)).toBe("");
    expect(prs.landed("thread", "t1", true, asks)).toEqual(["A1035"]);
  });

  it("keeps a PR link ref with a step after it open", async () => {
    const { prs } = rig({ "2152": "MERGED" });
    const asks = [ask(1035, { ref: "https://github.com/aiedwardyi/Wink/pull/2152/files; real phone test" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual([]);
    expect(prs.stepNote("bot", "thread", asks)).toContain("step left: real phone test.");
  });
});

describe("a bot edit in the closing turn", () => {
  it("is not closed over a bot reply that keeps it building", async () => {
    const { prs } = rig({ "2152": "MERGED" });
    const asks = [ask(1035, { ref: "PR 2152" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    prs.closing("thread", "t1", prs.take("bot", "thread", asks));
    const replied = mergeTaskAsks({ asks }, [{ id: "A1035", status: "building" }], 5_000);
    if ("error" in replied) throw new Error(replied.error);
    expect(prs.landed("thread", "t1", true, replied.asks)).toEqual([]);
  });
});
