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
const flush = () => new Promise((done) => setImmediate(done));

type StartOpts = { threadId?: string; cardContinuation?: boolean; paneNoteWake?: boolean; unattended?: boolean; keepGoingWake?: boolean; automationSource?: string; commsDepth?: number };
type View = { number: number; title: string; state: "OPEN" | "MERGED" | "CLOSED"; isDraft?: boolean; mergeCommit?: { oid: string } | null; repo?: string };

function fakeGh(views: Record<string, View>, compare: Record<string, string> = {}) {
  const calls: string[][] = [];
  const gh = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "api") {
      const status = compare[args[1]!];
      if (!status) throw new Error("HTTP 404");
      return `${status}\n`;
    }
    const view = views[args[2]!];
    if (!view) throw new Error("no pull requests found");
    return JSON.stringify({ ...view, url: `https://github.com/${view.repo ?? "aiedwardyi/Wink"}/pull/${view.number}` });
  };
  return { gh, calls };
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
      "[Wink unlanded - 3 PRs not in the user's build: #13 fix: change number 13 (3d, merged, not released); #12 fix: change number 12 (18h); #14 fix: change number 14 (<1h, draft). Before saying fixed or asking them to test, check it is merged and released.]",
    );
    const many = unlandedHeader(Array.from({ length: 11 }, (_, index) => pr(100 + index, 30 - index)), NOW);
    expect(many.match(/#1\d\d /g)).toHaveLength(8);
    expect(many).toContain("#100 fix: change number 100 (30h)");
    expect(many).toContain("; +3 more.");
  });

  it("names the repo once PRs span more than one", () => {
    expect(unlandedHeader([pr(1, 2), { ...pr(2, 1), repo: "me/site" }], NOW)).toContain("wink#1 fix: change number 1 (2h); site#2");
  });

  it("stays small", () => {
    const list = (count: number) => Array.from({ length: count }, (_, index) =>
      ({ ...pr(1600 + index, 40 - index, index % 2 ? "merged, not in your build" : "open"), title: "fix: close list and field menus only when their own list scrolls" }));
    const typical = tokens(unlandedHeader(list(3), NOW));
    const max = tokens(unlandedHeader(list(30), NOW));
    expect(typical).toBeLessThanOrEqual(110);
    expect(max).toBeLessThanOrEqual(240);
  });
});

describe("createUnlandedWork", () => {
  const views = {
    "1640": { number: 1640, title: "fix: tell bots what has not landed", state: "OPEN" },
    "1641": { number: 1641, title: "feat: merged and installed", state: "MERGED", mergeCommit: { oid: "aaa" } },
    "1642": { number: 1642, title: "feat: merged after the installed tag", state: "MERGED", mergeCommit: { oid: "bbb" } },
    "1643": { number: 1643, title: "fix: closed unmerged", state: "CLOSED" },
    "7": { number: 7, title: "fix: other repo", state: "MERGED", mergeCommit: { oid: "ccc" }, repo: "me/site" },
  } satisfies Record<string, View>;
  const compare = { "repos/aiedwardyi/wink/compare/v1.0.268...aaa": "behind", "repos/aiedwardyi/wink/compare/v1.0.268...bbb": "ahead" };
  const messages = [
    report(NOW - 30 * HOUR, "PR 1641"),
    report(NOW - 20 * HOUR, "PR 1642"),
    report(NOW - 18 * HOUR, "PR 1640"),
    report(NOW - 10 * HOUR, "PR 1643"),
    report(NOW - 5 * HOUR, "https://github.com/me/site/pull/7"),
  ];

  it("lists what is open or not in the installed build and drops merged+installed and closed", async () => {
    const { gh } = fakeGh(views, compare);
    const work = createUnlandedWork({ reports: () => messages, repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => NOW });
    await work.refresh("bot-1");
    expect(work.take("bot-1")).toBe(
      "[Wink unlanded - 3 PRs not in the user's build: wink#1642 feat: merged after the installed tag (20h, merged, not in your build); wink#1640 fix: tell bots what has not landed (18h); site#7 fix: other repo (5h, merged, not released). Before saying fixed or asking them to test, check it is merged and released.]",
    );
  });

  it("keeps merged PRs listed when the installed version is unknown", async () => {
    const { gh } = fakeGh(views, compare);
    const work = createUnlandedWork({ reports: () => messages.slice(0, 1), repoDir: () => "D:/repo", version: "", gh, now: () => NOW });
    await work.refresh("bot-1");
    expect(work.take("bot-1")).toContain("#1641 feat: merged and installed (30h, merged, not released)");
  });

  it("asks gh at most every 10 minutes and never again for a settled PR", async () => {
    let at = NOW;
    const { gh, calls } = fakeGh(views, compare);
    const work = createUnlandedWork({ reports: () => messages, repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => at });
    await work.refresh("bot-1");
    const first = calls.length;
    at += UNLANDED_REFRESH_MS - 1;
    await work.refresh("bot-1");
    expect(calls.length).toBe(first);
    at += 1;
    await work.refresh("bot-1");
    expect(calls.slice(first)).toEqual([["pr", "view", "1640", "--json", "number,title,url,state,isDraft,mergeCommit"]]);
  });

  it("never makes a send wait on a slow gh", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const { gh: fast } = fakeGh(views, compare);
    const gh = async (cwd: string, args: string[]) => { await gate; return fast(cwd, args); };
    const work = createUnlandedWork({ reports: () => messages.slice(2, 3), repoDir: () => "D:/repo", version: "1.0.268", gh, now: () => NOW });
    const started = performance.now();
    expect(work.take("bot-1")).toBe("");
    await flush();
    expect(work.take("bot-1")).toBe("");
    expect(performance.now() - started).toBeLessThan(50);
    release();
    await work.refresh("bot-1");
    expect(work.take("bot-1")).toContain("#1640 fix: tell bots what has not landed (18h)");
  });

  it("adds no line and no error without gh or a repo", async () => {
    const missing = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
    const noGh = createUnlandedWork({ reports: () => messages, repoDir: () => "D:/repo", version: "1.0.268", gh: missing, now: () => NOW });
    await noGh.refresh("bot-1");
    expect(noGh.take("bot-1")).toBe("");
    const { gh, calls } = fakeGh(views, compare);
    const noRepo = createUnlandedWork({ reports: () => messages.slice(0, 4), repoDir: () => undefined, version: "1.0.268", gh, now: () => NOW });
    await noRepo.refresh("bot-1");
    expect(noRepo.take("bot-1")).toBe("");
    expect(calls).toEqual([]);
  });
});

describe("unlanded wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("rides only turns the user typed, beside the other turn notices", () => {
    const start = source.indexOf("function turnStartedByUser");
    const fn = ts.transpileModule(source.slice(start, source.indexOf("const SHOW_IMAGE_GUIDANCE", start)), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    // SAFETY: the code is index.ts's own turnStartedByUser, only stripped of types.
    const typed = runInNewContext(`${fn}turnStartedByUser`) as (opts: StartOpts) => boolean;
    expect(typed({})).toBe(true);
    expect(typed({ threadId: "t", cardContinuation: true, paneNoteWake: true })).toBe(false);
    expect(typed({ threadId: "t", cardContinuation: true, unattended: true, keepGoingWake: true })).toBe(false);
    expect(typed({ automationSource: "schedule" })).toBe(false);
    expect(typed({ commsDepth: 1 })).toBe(false);
    expect(source).toContain('const unlandedNotice = turnStartedByUser(opts) ? unlandedWork.take(bot.id) : "";');
    expect(source).toContain("...(unlandedNotice ? [unlandedNotice] : [])");
    expect(source).toContain("void unlandedWork.refresh(bot.id);");
  });
});
