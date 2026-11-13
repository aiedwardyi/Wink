import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mapFlowStages, type MapFlow } from "../shared/map-flow.ts";
import { createMapFlow, mapPr } from "./map-pr.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

const run = (name: string, conclusion = "SUCCESS", status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion: status === "COMPLETED" ? conclusion : "", detailsUrl: `https://github.com/o/r/actions/runs/1/job/${name.length}`, workflowName: "CI" });
const review = (login: string, state: string, submittedAt = "2026-11-12T18:46:52Z") => ({ id: login + state, author: { login }, body: "", state, submittedAt });
const view = (over: Record<string, unknown> = {}) => ({
  number: 1529, state: "OPEN", isDraft: false, url: "https://github.com/o/r/pull/1529", title: "feat: arrow keys", baseRefName: "review-base", mergedAt: null, reviewDecision: "",
  statusCheckRollup: [run("typecheck"), run("vitest 1"), { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS", targetUrl: "https://coderabbit.ai/x" }],
  reviews: [review("claude", "COMMENTED")], ...over,
});
const flow = (pr: MapFlow["pr"], over: Partial<MapFlow> = {}): MapFlow => ({ branch: "feat/map-keys", commits: [{ sha: "1404479aa", subject: "fix: arrow" }, { sha: "1137b98bb", subject: "fix: fold" }], total: 2, pushed: 2, web: "https://github.com/o/r", pr, ...over });
const stage = (value: MapFlow, key: string) => mapFlowStages(value).find(item => item.key === key);

it("lights every stage of an open PR with passing checks", () => {
  const stages = mapFlowStages(flow(mapPr(view(), 0)));
  expect(stages.map(item => [item.key, item.on, item.tone])).toEqual([
    ["commit", true, undefined], ["push", true, undefined], ["pr", true, "open"], ["checks", true, "ok"], ["review", true, undefined], ["merge", false, undefined],
  ]);
  expect(stages.find(item => item.key === "checks")).toMatchObject({ pass: 3, total: 3, url: "https://github.com/o/r/pull/1529/checks" });
  expect(stages[0]).toMatchObject({ url: "https://github.com/o/r/pull/1529/commits/1404479aa" });
});

it("counts failing and running checks and names the failing ones", () => {
  const pr = mapPr(view({ statusCheckRollup: [run("typecheck", "FAILURE"), run("vitest 1", "", "IN_PROGRESS"), run("vitest 2"), run("lint", "SKIPPED"), { __typename: "StatusContext", context: "deploy", state: "ERROR" }] }), 0);
  const checks = stage(flow(pr), "checks");
  expect(checks).toMatchObject({ on: true, tone: "bad", fail: 2, pass: 1, pending: 1, total: 4 });
  expect(checks?.detail).toEqual(["typecheck", "deploy"]);
  const running = stage(flow(mapPr(view({ statusCheckRollup: [run("a"), run("b", "", "QUEUED")] }), 0)), "checks");
  expect(running).toMatchObject({ on: false, tone: "run", pending: 1, pass: 1 });
});

it("shows changes requested with reviewers and open threads", () => {
  const pr = mapPr(view({ reviewDecision: "CHANGES_REQUESTED", reviews: [review("coderabbitai", "COMMENTED"), review("aiedwardyi", "CHANGES_REQUESTED"), review("aiedwardyi", "COMMENTED", "2026-11-12T19:00:00Z")] }), 3);
  expect(pr?.reviews).toEqual([{ login: "coderabbitai", state: "commented" }, { login: "aiedwardyi", state: "changes" }]);
  expect(stage(flow(pr), "review")).toMatchObject({ on: true, tone: "bad", threads: 3, who: ["coderabbitai", "aiedwardyi"] });
  expect(stage(flow(mapPr(view({ reviews: [] }), 0)), "review")).toMatchObject({ on: false, who: [] });
});

it("ends a merged PR on the merge and a closed one on the close", () => {
  const merged = mapPr(view({ state: "MERGED", mergedAt: "2026-11-12T19:14:03Z" }), 0);
  expect(stage(flow(merged), "merge")).toMatchObject({ on: true, tone: "merged", at: Date.parse("2026-11-12T19:14:03Z") });
  expect(stage(flow(merged), "pr")).toMatchObject({ tone: "merged" });
  const closed = mapPr(view({ state: "CLOSED" }), 0);
  expect(stage(flow(closed), "merge")).toMatchObject({ on: true, tone: "closed" });
  expect(mapPr(view({ isDraft: true }), null)?.state).toBe("draft");
});

it("ends at the last true git stage with no PR or no gh", () => {
  expect(mapFlowStages(flow(null)).map(item => [item.key, item.on])).toEqual([["commit", true], ["push", true]]);
  expect(stage(flow(null), "commit")?.url).toBe("https://github.com/o/r/commit/1404479aa");
  expect(mapFlowStages(flow(null, { pushed: 1 })).map(item => item.url)).toEqual([undefined, "https://github.com/o/r/tree/feat/map-keys"]);
  expect(stage(flow(mapPr(view(), 0), { pushed: 1 }), "commit")?.url).toBe("https://github.com/o/r/pull/1529/commits");
  expect(mapFlowStages(flow(null, { pushed: 0, web: undefined })).map(item => [item.key, item.on, item.url])).toEqual([["commit", true, undefined]]);
  expect(mapFlowStages(flow(null, { commits: [], total: 0, pushed: 0 })).map(item => [item.key, item.on])).toEqual([["commit", false]]);
  expect(mapPr({ nope: true }, 0)).toBeNull();
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "wink-map-pr-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8" }).trim();
  const commit = (message: string) => { writeFileSync(join(root, "file.ts"), message); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "feat/x");
  return { root, git, commit, base: commit("initial") };
}

it("reads commits and pushes from git and asks gh only once a branch is pushed", async () => {
  const { root, git, commit, base } = repo();
  const gh = vi.fn(async (_cwd: string, args: string[]) => args[0] === "api" ? JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } } } } }) : JSON.stringify(view()));
  const flows = createMapFlow(gh);
  expect(await flows.flow(root, base)).toMatchObject({ branch: "feat/x", total: 0, pushed: 0, pr: null });
  const first = commit("feat: one");
  commit("fix: two");
  expect(await flows.flow(root, base)).toMatchObject({ total: 2, pushed: 0, commits: [{ subject: "fix: two" }, { sha: first, subject: "feat: one" }], pr: null });
  expect(gh).not.toHaveBeenCalled();
  git("remote", "add", "origin", "git@github.com:o/r.git");
  git("update-ref", "refs/remotes/origin/feat/x", first);
  const pushed = await flows.flow(root, base);
  expect(pushed).toMatchObject({ total: 2, pushed: 1, web: "https://github.com/o/r", pr: { number: 1529, threads: 1 } });
  expect(gh.mock.calls.map(call => call[1][0])).toEqual(["pr", "api"]);
  expect(gh.mock.calls[0][1]).toEqual(expect.arrayContaining(["view", "--json"]));
  await flows.flow(root, base);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("stops asking gh about a merged PR and falls back quietly when gh fails", async () => {
  const { root, git, commit, base } = repo();
  git("remote", "add", "origin", "https://github.com/o/r.git");
  git("update-ref", "refs/remotes/origin/feat/x", commit("feat: one"));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const merged = vi.fn(async (_cwd: string, args: string[]) => args[0] === "api" ? "{}" : JSON.stringify(view({ state: "MERGED", mergedAt: "2026-11-12T19:14:03Z" })));
    const flows = createMapFlow(merged);
    expect((await flows.flow(root, base)).pr).toMatchObject({ state: "merged", threads: null });
    vi.setSystemTime(Date.now() + 3_600_000);
    await flows.flow(root, base);
    expect(merged).toHaveBeenCalledTimes(2);
    const signedOut = vi.fn(async () => { throw Object.assign(new Error("gh auth login"), { code: 4 }); });
    const quiet = createMapFlow(signedOut);
    expect(await quiet.flow(root, base)).toMatchObject({ total: 1, pushed: 1, pr: null });
    await quiet.flow(root, base);
    expect(signedOut).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 121_000);
    await quiet.flow(root, base);
    expect(signedOut).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
