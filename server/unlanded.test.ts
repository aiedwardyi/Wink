import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createUnlandedWork, reportedPrs, UNLANDED_REFRESH_MS, unlandedHeader, type UnlandedPr } from "./unlanded.ts";

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 15, 9).getTime();
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
const report = (at: number, body: string, branch = "fix/x") =>
  ({ kind: "note", at, text: `[pane 1234abcd] [CARD] from Mentor (bot-1): DONE CARD branch=${branch} sha=abc1234 dirty=no\n${body}` });

type StartOpts = { threadId?: string; cardContinuation?: boolean; paneNoteWake?: boolean; unattended?: boolean; keepGoingWake?: boolean; automationSource?: string; commsDepth?: number };
type View = { number: number; title: string; state: "OPEN" | "MERGED" | "CLOSED"; isDraft?: boolean; mergeCommit?: { oid: string } | null; repo?: string };

// A compare status starting with "!" fails with that message.
function fakeGh(views: ReadonlyMap<string, View>, compare: ReadonlyMap<string, string> = new Map()) {
  const calls: string[][] = [];
  const cwds: string[] = [];
  const gh = async (cwd: string, args: string[]) => {
    calls.push(args);
    cwds.push(cwd);
    if (args[0] === "api") {
      const status = compare.get(args[1]!);
      if (!status) throw new Error("HTTP 404");
      if (status.startsWith("!")) throw new Error(status.slice(1));
      return `${status}\n`;
    }
    const view = views.get(args[2]!);
    if (!view) throw new Error("no pull requests found");
    return JSON.stringify({ ...view, url: `https://github.com/${view.repo ?? "aiedwardyi/Wink"}/pull/${view.number}` });
  };
  return { gh, calls, cwds };
}

describe("reportedPrs", () => {
  it("reads PR numbers, PR links and else the branch from orbit-msg reports only", () => {
    expect(reportedPrs([
      report(1, "PR 1640 abc123 | header y"),
      report(2, "see https://github.com/Other/Repo/pull/7 and PR #8"),
      report(3, "no pr yet", "fix/branch-only"),
      report(4, "in place", "main"),
      { kind: "note", at: 5, text: "[pane 1234abcd] from Mentor (bot-1): PR 99 is up" },
      { kind: "text", at: 6, text: "PR 98" },
    ])).toEqual([
      { at: 3, branch: "fix/branch-only" },
      { at: 2, repo: "other/repo", number: 7 },
      { at: 2, number: 8 },
      { at: 1, number: 1640 },
    ]);
  });
});

describe("unlandedHeader", () => {
  const pr = (number: number, hoursAgo: number, state: UnlandedPr["state"] = "open"): UnlandedPr =>
    ({ repo: "aiedwardyi/wink", number, title: `fix: change number ${number}`, state, at: NOW - hoursAgo * HOUR });

  it("is empty with nothing unlanded", () => {
    expect(unlandedHeader([], NOW)).toBe("");
  });

  it("lists oldest first, marks merged ones and caps at eight", () => {
    expect(unlandedHeader([pr(12, 18), pr(13, 72, "merged, not released"), pr(14, 0.5, "draft")], NOW)).toBe(
      "[Wink unlanded - 3 PRs in aiedwardyi/wink not in the user's build: #13 fix: change number 13 (3d, merged, not released); #12 fix: change number 12 (18h); #14 fix: change number 14 (<1h, draft). Before saying fixed or asking them to test, check it is merged and released.]",
    );
    const many = unlandedHeader(Array.from({ length: 11 }, (_, index) => pr(100 + index, 30 - index)), NOW);
    expect(many.match(/#1\d\d /g)).toHaveLength(8);
    expect(many).toContain("#100 fix: change number 100 (30h)");
    expect(many).toContain("; +3 more.");
  });

  it("names the one repo, or each PR's owner/repo once they span more than one", () => {
    expect(unlandedHeader([{ ...pr(7, 2), repo: "me/site" }], NOW)).toContain("1 PR in me/site not in the user's build: #7 fix: change number 7 (2h).");
    expect(unlandedHeader([pr(1, 2), { ...pr(2, 1), repo: "me/site" }], NOW)).toContain("2 PRs not in the user's build: aiedwardyi/wink#1 fix: change number 1 (2h); me/site#2");
    expect(unlandedHeader([{ ...pr(1, 2), repo: "alice/site" }, { ...pr(2, 1), repo: "bob/site" }], NOW)).toContain("alice/site#1 fix: change number 1 (2h); bob/site#2");
  });

  it("stays small", () => {
    const list = (count: number) => Array.from({ length: count }, (_, index) =>
      ({ ...pr(1600 + index, 40 - index, index % 2 ? "merged, not in your build" : "open"), title: "fix: close list and field menus only when their own list scrolls" }));
    const typical = tokens(unlandedHeader(list(3), NOW));
    const max = tokens(unlandedHeader(list(30), NOW));
    const mixed = tokens(unlandedHeader(list(30).map((item, index) => ({ ...item, repo: index % 2 ? "aiedwardyi/wink" : "aiedwardyi/wink-site" })), NOW));
    expect(typical).toBeLessThanOrEqual(120);
    expect(max).toBeLessThanOrEqual(240);
    expect(mixed).toBeLessThanOrEqual(290);
  });
});

describe("createUnlandedWork", () => {
  const allViews = {
    "1640": { number: 1640, title: "fix: tell bots what has not landed", state: "OPEN" },
    "1641": { number: 1641, title: "feat: merged and installed", state: "MERGED", mergeCommit: { oid: "aaa" } },
    "1642": { number: 1642, title: "feat: merged after the installed tag", state: "MERGED", mergeCommit: { oid: "bbb" } },
    "1643": { number: 1643, title: "fix: closed unmerged", state: "CLOSED" },
    "7": { number: 7, title: "fix: other repo", state: "MERGED", mergeCommit: { oid: "ccc" }, repo: "me/site" },
  } satisfies Record<string, View>;
  const COMPARE_AAA = "repos/aiedwardyi/wink/compare/v1.0.268...aaa";
  const views = () => new Map<string, View>(Object.entries(allViews));
  const compare = () => new Map([[COMPARE_AAA, "behind"], ["repos/aiedwardyi/wink/compare/v1.0.268...bbb", "ahead"]]);
  const messages = [
    report(NOW - 30 * HOUR, "PR 1641"),
    report(NOW - 20 * HOUR, "PR 1642"),
    report(NOW - 18 * HOUR, "PR 1640"),
    report(NOW - 10 * HOUR, "PR 1643"),
    report(NOW - 5 * HOUR, "https://github.com/me/site/pull/7"),
  ];

  it("lists what is open or not in the installed build and drops merged+installed and closed", async () => {
    const { gh } = fakeGh(views(), compare());
    const work = createUnlandedWork({ reports: () => messages, repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => NOW });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toBe(
      "[Wink unlanded - 3 PRs not in the user's build: aiedwardyi/wink#1642 feat: merged after the installed tag (20h, merged, not in your build); aiedwardyi/wink#1640 fix: tell bots what has not landed (18h); me/site#7 fix: other repo (5h, merged, not released). Before saying fixed or asking them to test, check it is merged and released.]",
    );
  });

  it("keeps merged PRs listed when the installed version is unknown", async () => {
    const { gh } = fakeGh(views(), compare());
    const work = createUnlandedWork({ reports: () => messages.slice(0, 1), repoDir: () => "D:/repo", version: "", gh, now: () => NOW });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toContain("#1641 feat: merged and installed (30h, merged, not released)");
  });

  it("asks gh at most every 10 minutes and never again for a settled PR", async () => {
    let at = NOW;
    const { gh, calls } = fakeGh(views(), compare());
    const work = createUnlandedWork({ reports: () => messages, repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => at });
    await work.refresh("bot-1", "t-a");
    const first = calls.length;
    at += UNLANDED_REFRESH_MS - 1;
    await work.refresh("bot-1", "t-a");
    expect(calls.length).toBe(first);
    at += 1;
    await work.refresh("bot-1", "t-a");
    expect(calls.slice(first).map((args) => args[2])).toEqual(["1643", "1640"]);
  });

  it("brings back a closed PR once it reopens", async () => {
    let at = NOW;
    const live = views();
    const { gh } = fakeGh(live, compare());
    const work = createUnlandedWork({ reports: () => messages.slice(3, 4), repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => at });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toBe("");
    live.set("1643", { ...allViews["1643"], state: "OPEN" });
    at += UNLANDED_REFRESH_MS;
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toContain("#1643 fix: closed unmerged (10h)");
  });

  it("retries a build check that failed and drops the PR once it proves installed", async () => {
    let at = NOW;
    const checks = compare();
    checks.set(COMPARE_AAA, "!error connecting to api.github.com");
    const { gh } = fakeGh(views(), checks);
    const work = createUnlandedWork({ reports: () => messages.slice(0, 1), repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => at });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toContain("#1641 feat: merged and installed (30h, merged, not released)");
    checks.set(COMPARE_AAA, "behind");
    at += UNLANDED_REFRESH_MS;
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toBe("");
  });

  it("stops asking for a missing version tag or a number that names no PR, and keeps asking for a branch", async () => {
    let at = NOW;
    const { gh, calls } = fakeGh(views(), compare());
    const reports = [report(NOW - 3 * HOUR, "PR 1641"), report(NOW - 2 * HOUR, "PR 9999"), report(NOW - HOUR, "pushed", "fix/no-pr-yet")];
    const work = createUnlandedWork({ reports: () => reports, repoDir: () => "D:/repo", version: "1.0.269-dev.1", gh, now: () => at });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toContain("#1641 feat: merged and installed (3h, merged, not released)");
    const first = calls.length;
    at += UNLANDED_REFRESH_MS;
    await work.refresh("bot-1", "t-a");
    expect(calls.slice(first).map((args) => args[2])).toEqual(["fix/no-pr-yet"]);
  });

  it("never makes a send wait on a slow gh", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const { gh: fast } = fakeGh(views(), compare());
    const gh = async (cwd: string, args: string[]) => { await gate; return fast(cwd, args); };
    const work = createUnlandedWork({ reports: () => messages.slice(2, 3), repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => NOW });
    const pending = work.refresh("bot-1", "t-a");
    const started = performance.now();
    expect(work.take("t-a")).toBe("");
    expect(performance.now() - started).toBeLessThan(50);
    release();
    await pending;
    expect(work.take("t-a")).toContain("#1640 fix: tell bots what has not landed (18h)");
  });

  it("gives each task only the PRs its own reports name", async () => {
    const threads = new Map([["t-a", [report(NOW - 18 * HOUR, "PR 1640")]], ["t-b", [report(NOW - 2 * HOUR, "PR 1642")]]]);
    const dirs = new Map([["t-a", "D:/repo-a"], ["t-b", "D:/repo-b"]]);
    const { gh, calls, cwds } = fakeGh(views(), compare());
    const work = createUnlandedWork({ reports: (threadId) => threads.get(threadId) ?? [], repoDir: (_botId, threadId) => dirs.get(threadId), version: "1.0.268", gh, now: () => NOW });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toContain("#1640 fix: tell bots what has not landed (18h)");
    // the user switched to task B before any B turn settled
    expect(work.take("t-b")).toBe("");
    await work.refresh("bot-1", "t-b");
    expect(work.take("t-b")).toContain("#1642 feat: merged after the installed tag");
    expect(work.take("t-b")).not.toContain("#1640");
    expect(work.take("t-a")).not.toContain("#1642");
    expect(calls.map((args, index) => [args[0], args[2], cwds[index]]).filter(([kind]) => kind === "pr")).toEqual([["pr", "1640", "D:/repo-a"], ["pr", "1642", "D:/repo-b"]]);
  });

  it("re-resolves a branch whose PR settled, so the branch's next PR shows", async () => {
    let at = NOW;
    const live = views();
    live.set("fix/reused", allViews["1641"]);
    const { gh } = fakeGh(live, compare());
    const reports = [report(NOW - 2 * HOUR, "pushed", "fix/reused")];
    const work = createUnlandedWork({ reports: () => reports, repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => at });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toBe("");
    live.set("fix/reused", allViews["1640"]);
    at += UNLANDED_REFRESH_MS;
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toContain("#1640 fix: tell bots what has not landed (2h)");
  });

  it("keeps the repo of a PR reported from outside the task's folder", async () => {
    const { gh } = fakeGh(views(), compare());
    const work = createUnlandedWork({ reports: () => messages.slice(4), repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => NOW });
    await work.refresh("bot-1", "t-a");
    expect(work.take("t-a")).toContain("1 PR in me/site not in the user's build: #7 fix: other repo");
  });

  it("runs again for a report that lands while a refresh waits on gh", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const { gh: fast, calls } = fakeGh(views(), compare());
    const gh = async (cwd: string, args: string[]) => { if (args[2] === "1640") await gate; return fast(cwd, args); };
    const reports = [report(NOW - 18 * HOUR, "PR 1640")];
    const work = createUnlandedWork({ reports: () => reports, repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => NOW });
    const first = work.refresh("bot-1", "t-a");
    reports.push(report(NOW - HOUR, "PR 1642"));
    const second = work.refresh("bot-1", "t-a");
    release();
    await first;
    await second;
    expect(calls.filter((args) => args[0] === "pr").map((args) => args[2])).toEqual(["1640", "1642"]);
    expect(work.take("t-a")).toContain("#1642 feat: merged after the installed tag");
    expect(work.take("t-a")).toContain("#1640 fix: tell bots what has not landed");
  });

  it("reads only the cache on take, so a send starts no gh", async () => {
    const { gh, calls } = fakeGh(views(), compare());
    const work = createUnlandedWork({ reports: () => messages, repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => NOW });
    expect(work.take("t-a")).toBe("");
    await new Promise((done) => setImmediate(done));
    expect(calls).toEqual([]);
  });

  it("adds no line and no error without gh or a repo", async () => {
    const missing = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
    const noGh = createUnlandedWork({ reports: () => messages, repoDir: () => "D:/repo", version: "1.0.268", gh: missing, now: () => NOW });
    await noGh.refresh("bot-1", "t-a");
    expect(noGh.take("t-a")).toBe("");
    const { gh, calls } = fakeGh(views(), compare());
    const noRepo = createUnlandedWork({ reports: () => messages.slice(0, 4), repoDir: () => undefined, version: "1.0.268", gh, now: () => NOW });
    await noRepo.refresh("bot-1", "t-a");
    expect(noRepo.take("t-a")).toBe("");
    expect(calls).toEqual([]);
  });
});

describe("unlanded wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("rides only turns the user typed, beside the other turn notices", () => {
    const start = source.indexOf("function turnStartedByUser");
    const end = source.indexOf("const SHOW_IMAGE_GUIDANCE", start);
    if (start < 0 || end < start) throw new Error("index.ts no longer has turnStartedByUser before SHOW_IMAGE_GUIDANCE; update this slice");
    const fn = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    // SAFETY: the code is index.ts's own turnStartedByUser, only stripped of types.
    const typed = runInNewContext(`${fn}turnStartedByUser`) as (opts: StartOpts) => boolean;
    expect(typed({})).toBe(true);
    expect(typed({ threadId: "t", cardContinuation: true, paneNoteWake: true })).toBe(false);
    expect(typed({ threadId: "t", cardContinuation: true, unattended: true, keepGoingWake: true })).toBe(false);
    expect(typed({ automationSource: "schedule" })).toBe(false);
    expect(typed({ commsDepth: 1 })).toBe(false);
    expect(source).toContain('const unlandedNotice = turnStartedByUser(opts) ? unlandedWork.take(threadId) : "";');
    expect(source).toContain("...(unlandedNotice ? [unlandedNotice] : [])");
    expect(source).toContain("void unlandedWork.refresh(bot.id, event.threadId);");
    expect(source).toContain("await unlandedWork.refresh(bot.id, bot.threadId);");
    expect(source).toContain("const pinned = store.taskByThread(botId, threadId)?.cwd;");
    expect(source).not.toContain("store.bot(botId)?.lastProjectCwd");
  });

  it("refreshes a task's list as soon as a worker report is stored, so an idle bot's next typed turn has it", () => {
    const route = source.slice(source.indexOf('path === "/api/mailbox"'), source.indexOf("return json(res, 200, { ok: true, id: message.id });"));
    const stored = route.indexOf('const message = store.appendMessage(source.threadId, { role: "bot", kind: "note"');
    expect(stored).toBeGreaterThan(0);
    expect(route.indexOf('if (kind === "report") void unlandedWork.refresh(source.id, source.threadId);')).toBeGreaterThan(stored);
  });
});
