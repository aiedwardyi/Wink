import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mapGit } from "./map-git.ts";
import { createRevertIndex, gitHome, parseRevertLog, revertHit, type RevertGit } from "./revert-index.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const commit = (sha: string, when: string, subject: string, body: string, files: string[]) => `\x1e${sha.padEnd(40, "0")}\x1f${at(when)}\x1f${subject}\x1f${body}\x1f\n\n${files.join("\n")}\n`;
// #1595 reverted #1587 55 min after it merged; verify-cast.mjs has 4 commits, server/index.ts many
const BLUR_LOG = [
  commit("aaaaaaa11", "2026-11-20T09:00:00Z", "fix: send button (#1990)", "", ["server/index.ts"]),
  commit("6cf938e74", "2026-11-14T10:56:00Z", "revert: Live Verify load wait fails healthy animated pages (#1595)", "* revert: Live Verify load wait fails healthy animated pages\n\nReverts #1587 (7500e57b0). A small page with an endless rotate animation was reported as crashed.", ["electron/verify-cast.mjs", "server/index.ts"]),
  commit("7500e57b0", "2026-11-14T10:01:00Z", "fix: Live Verify checks a slow page once it has loaded, sharp, with cursors only on checked things (#1587)", "", ["electron/verify-cast.mjs", "server/index.ts"]),
  commit("6cb0f2f52", "2026-10-30T10:00:00Z", "fix: pace live verify replays and keep the page in view (#1157)", "", ["electron/verify-cast.mjs"]),
  commit("d48164e11", "2026-10-01T10:00:00Z", "feat: watch done-checks live or as a replay (#1098)", "", ["electron/verify-cast.mjs", "src/components/VerifyWatch.tsx"]),
  ...Array.from({ length: 12 }, (_, index) => commit(`bbbbbbb${index}`, "2026-11-10T10:00:00Z", `fix: chat ${index} (#${1700 + index})`, "", ["server/index.ts"])),
].join("");

const NOW = Date.parse("2026-11-24T04:00:00Z");

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

// main has #1595 reverting #1587; old forked before the revert; each worker has its own commit
function gitRepos(workers = 0) {
  const root = mkdtempSync(join(tmpdir(), "revert-git-"));
  roots.push(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { windowsHide: true, encoding: "utf8" }).trim();
  const commit = (cwd: string, path: string, text: string, message: string) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const main = join(root, "main");
  const old = join(root, "old");
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), main);
  commit(main, "electron/verify-cast.mjs", "v1\n", "feat: watch done-checks live (#1098)");
  commit(main, "docs/가이드.md", "v1\n", "docs: guide (#1100)");
  const fix = commit(main, "electron/verify-cast.mjs", "v2\n", "fix: Live Verify checks a slow page once it has loaded (#1587)");
  commit(main, "docs/가이드.md", "v2\n", "docs: guide again (#1588)");
  git(main, "worktree", "add", "-q", "-b", "feat/old", old, fix);
  commit(main, "electron/verify-cast.mjs", "v1\n", "revert: Live Verify load wait fails healthy animated pages (#1595)\n\nReverts #1587.");
  commit(main, "docs/가이드.md", "v1\n", 'Revert "docs: guide again (#1588)" (#1596)');
  git(main, "push", "-q", "origin", "main");
  const others = Array.from({ length: workers }, (_, index) => {
    const dir = join(root, `w${index}`);
    git(main, "worktree", "add", "-q", "-b", `feat/w${index}`, dir, "main");
    commit(dir, `w${index}.txt`, "w\n", `wip: ${index}`);
    return dir;
  });
  return { main, old, others };
}

function counted() {
  let passes = 0;
  const git: RevertGit = (cwd, args) => { passes += 1; return mapGit(cwd, args, 64 * 1024 * 1024); };
  return { git, passes: () => passes };
}

const SHARP = "## Purpose\nSharpen electron/verify-cast.mjs:20 frames.\n";

// like git: a lock file renamed over the ref
function moveRef(dir: string, sha: string) {
  const ref = join(dir, ".git", "refs", "heads", "main");
  writeFileSync(`${ref}.lock`, sha);
  renameSync(`${ref}.lock`, ref);
}

function repo(head = "ref: refs/heads/main") {
  const dir = mkdtempSync(join(tmpdir(), "revert-index-"));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `${head}\n`);
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "1".repeat(40));
  return dir;
}

describe("revert index", () => {
  it("keeps revert commits with what they undid and counts each file's commits", () => {
    const log = parseRevertLog(BLUR_LOG);
    expect(log.reverts).toHaveLength(1);
    const [revert] = log.reverts;
    expect(revert).toMatchObject({ pr: 1595, files: ["electron/verify-cast.mjs", "server/index.ts"] });
    expect(revert!.undid.prs).toEqual([1587]);
    expect(revert!.undid.shas).toContain("7500e57b0");
    expect(revert!.undid.subject).toContain("Live Verify checks a slow page");
    expect(log.counts.get("electron/verify-cast.mjs")).toBe(4);
    expect(log.counts.get("server/index.ts")).toBe(15);
  });

  it("reads undone PRs from the revert's subject and its revert lines, never its own PR", () => {
    const log = parseRevertLog([
      commit("c1", "2026-11-17T10:00:00Z", "revert: phone pills/key card (#1812) and one-clip-at-a-time (#1825) (#1867)", "", ["a.ts"]),
      commit("c2", "2026-11-18T10:00:00Z", "revert: question cards back to the 11-15 behavior (#1873)", "* Revert \"fix: x (#1846)\"\n\nThis reverts commit 475676223885e6d053b6491eaecb9676f1300d96.\n\n* test: #12 is unrelated", ["b.ts"]),
      commit("c3", "2026-11-18T10:00:00Z", "fix: Media tab lists every picture again (#1999)", "Reverts #1922.", ["c.ts"]),
    ].join(""));
    expect(log.reverts.map((revert) => revert.undid.prs)).toEqual([[1812, 1825], [1846]]);
    expect(log.reverts[1]!.undid.shas).toEqual(["475676223885e6d053b6491eaecb9676f1300d96"]);
  });

  it("matches a named cold file unless the card cites the revert or what it undid", () => {
    const log = parseRevertLog(BLUR_LOG);
    const card = "## Purpose\nSharpen electron/verify-cast.mjs:20 frames.\n";
    expect(revertHit(log, card, NOW)?.file).toBe("electron/verify-cast.mjs");
    expect(revertHit(log, String.raw`Read D:\wink\electron\verify-cast.mjs.`, NOW)?.revert.pr).toBe(1595);
    for (const cited of ["#1595", "#1587", "6cf938e74", "7500e57b0"]) expect(revertHit(log, `${card}Look-first: ${cited}`, NOW), cited).toBeUndefined();
    expect(revertHit(log, "Change server/index.ts.", NOW)).toBeUndefined();
    expect(revertHit(log, "Change verify-cast.mjs.", NOW)).toBeUndefined();
    expect(revertHit(log, card, Date.parse("2026-12-20T00:00:00Z"))).toBeUndefined();
    expect(revertHit(log, card, Date.parse("2026-11-14T10:30:00Z"))).toBeUndefined();
  });

  it("finds the common dir of a worktree and nothing outside a repo", async () => {
    const main = repo();
    const worktree = mkdtempSync(join(tmpdir(), "revert-wt-"));
    const own = join(main, ".git", "worktrees", "wt");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(own, "commondir"), "../..\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${own}\n`);
    mkdirSync(join(worktree, "src"));
    expect((await gitHome(join(worktree, "src")))?.common).toBe(join(main, ".git"));
    expect(await gitHome(main)).toEqual({ common: join(main, ".git"), refs: "--branches", shallow: false });
    expect(await gitHome(mkdtempSync(join(tmpdir(), "revert-none-")))).toBeUndefined();
    expect(await gitHome("")).toBeUndefined();
    expect(await gitHome("relative/dir")).toBeUndefined();
  });

  it("runs one git pass per repo and runs again only when a ref moves or the interval passes", async () => {
    const dir = repo();
    let now = NOW;
    const calls: string[][] = [];
    const index = createRevertIndex({ git: async (_cwd, args) => { calls.push(args); return BLUR_LOG; }, now: () => now });
    expect(await index.hit(dir, "electron/verify-cast.mjs")).toBeUndefined();
    await index.refresh(dir);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(["log", "--since=90.days", "--name-only"]));
    expect((await index.hit(dir, "electron/verify-cast.mjs"))?.revert.pr).toBe(1595);
    await index.refresh(dir);
    expect(calls).toHaveLength(1);
    moveRef(dir, "2".repeat(40));
    await index.refresh(dir);
    expect(calls).toHaveLength(2);
    now += 10 * 60_000;
    await index.refresh(dir);
    expect(calls).toHaveLength(3);
  });

  it("keeps the last pass when git fails", async () => {
    const dir = repo();
    let fail = false;
    const index = createRevertIndex({ git: async () => { if (fail) throw new Error("git gone"); return BLUR_LOG; }, now: () => NOW });
    await index.refresh(dir);
    fail = true;
    moveRef(dir, "2".repeat(40));
    await expect(index.refresh(dir)).resolves.toBeUndefined();
    expect((await index.hit(dir, "electron/verify-cast.mjs"))?.revert.pr).toBe(1595);
  });
  it("matches file names with spaces, brackets and non-folder roots, and a folder file only by its whole path", () => {
    const files = ["docs/my guide.md", "src/app/users/[id]/page.tsx", "src/app/(dashboard)/page.tsx", "root-file.ts", "index.ts"];
    const log = parseRevertLog(files.map((file, index) => commit(`c${index}`, "2026-11-20T10:00:00Z", `revert: undo ${index} (#${2000 + index})`, "", [file])).join(""));
    for (const file of files) expect(revertHit(log, `Edit \`${file}\`.`, NOW)?.file, file).toBe(file);
    expect(revertHit(log, 'Edit "docs/my guide.md" and src/app/users/[id]/page.tsx.', NOW)?.file).toBe("docs/my guide.md");
    expect(revertHit(log, "Edit src/app/(dashboard)/page.tsx:12.", NOW)?.file).toBe("src/app/(dashboard)/page.tsx");
    expect(revertHit(log, String.raw`Read D:\wink\wt\x\root-file.ts and D:\wink\wt\x\src\app\users\[id]\page.tsx.`, NOW)?.file).toBe("src/app/users/[id]/page.tsx");
    expect(revertHit(log, String.raw`Read D:\wink\wt\x\root-file.ts.`, NOW)?.file).toBe("root-file.ts");
    for (const miss of ["Edit server/index.ts.", "Edit my-root-file.ts.", "Edit root-file.tsx.", "Edit index.ts.bak.", "Edit docs/my guide.mdx."]) expect(revertHit(log, miss, NOW), miss).toBeUndefined();
  });

  it("reads what a revert undid from a sha-only body, a direct revert and a Reverts line", () => {
    const undoneBySha = parseRevertLog(commit("aaaa111", "2026-11-20T10:00:00Z", 'Revert "fix: blur" (#1595)', `This reverts commit ${"bbbb222".padEnd(40, "0")}.`, ["a/b.ts"]) + commit("bbbb222", "2026-11-19T10:00:00Z", "fix: blur (#1587)", "", ["a/b.ts"]));
    expect(undoneBySha.reverts[0]!.undid.prs).toEqual([1587]);
    expect(revertHit(undoneBySha, "Edit a/b.ts. Look-first: #1587", NOW)).toBeUndefined();
    const direct = parseRevertLog(commit("aaaa111", "2026-11-20T10:00:00Z", "revert: undo (#1587)", "", ["a/b.ts"]) + commit("bbbb222", "2026-11-19T10:00:00Z", "fix: blur (#1587)", "", ["a/b.ts"]));
    expect(direct.reverts[0]).toMatchObject({ undid: { prs: [1587], subject: "fix: blur (#1587)" } });
    expect(direct.reverts[0]!.pr).toBeUndefined();
    const plural = parseRevertLog(commit("aaaa111", "2026-11-20T10:00:00Z", "Reverts #1587 (#1595)", "", ["a/b.ts"]) + commit("cccc333", "2026-11-20T09:00:00Z", "revert: blur (#1594)", "Reverts #1587.", ["a/b.ts"]) + commit("bbbb222", "2026-11-19T10:00:00Z", "fix: blur (#1587)", "", ["a/b.ts"]));
    expect(plural.reverts.map((revert) => [revert.pr, revert.undid.prs])).toEqual([[1595, [1587]], [1594, [1587]]]);
  });

  it("drops a revert that a newer revert undid, and both of the pair", () => {
    const log = parseRevertLog([
      commit("cccc333", "2026-11-16T10:00:00Z", 'Revert "revert: blur (#1595)" (#1610)', "Reverts #1595.", ["electron/verify-cast.mjs"]),
      commit("bbbb222", "2026-11-14T11:00:00Z", "revert: blur (#1595)", "Reverts #1587.", ["electron/verify-cast.mjs"]),
      commit("aaaa111", "2026-11-14T10:00:00Z", "fix: blur (#1587)", "", ["electron/verify-cast.mjs"]),
    ].join(""));
    expect(log.reverts).toEqual([]);
    expect(revertHit(log, SHARP, NOW)).toBeUndefined();
    const again = parseRevertLog(commit("dddd444", "2026-11-18T10:00:00Z", 'Revert "Revert "revert: blur (#1595)" (#1610)" (#1620)', "Reverts #1610.", ["electron/verify-cast.mjs"]) + commit("cccc333", "2026-11-16T10:00:00Z", 'Revert "revert: blur (#1595)" (#1610)', "Reverts #1595.", ["electron/verify-cast.mjs"]) + commit("bbbb222", "2026-11-14T11:00:00Z", "revert: blur (#1595)", "Reverts #1587.", ["electron/verify-cast.mjs"]) + commit("aaaa111", "2026-11-14T10:00:00Z", "fix: blur (#1587)", "", ["electron/verify-cast.mjs"]));
    expect(again.reverts.map((revert) => revert.pr)).toEqual([1595]);
  });

  it("checks every worktree against the same history, so one forked before a revert never hides it", async () => {
    for (const order of [["old", "main"], ["main", "old"]] as const) {
      const repos = gitRepos();
      const { git, passes } = counted();
      const index = createRevertIndex({ git });
      for (const name of order) await index.refresh(repos[name]);
      expect((await index.hit(repos.main, SHARP))?.revert.pr, order.join(">")).toBe(1595);
      expect((await index.hit(repos.old, SHARP))?.revert.pr, order.join(">")).toBe(1595);
      const warmed = passes();
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await Promise.all([repos.old, repos.main].map((cwd) => index.refresh(cwd)));
        expect((await index.hit(repos.main, SHARP))?.revert.pr).toBe(1595);
        await index.refresh(repos.main);
      }
      expect(passes() - warmed).toBe(0);
    }
  });

  it("indexes worktrees of one repo with one pass at boot, and names non-ASCII files as git wrote them", async () => {
    const repos = gitRepos(5);
    const serial = counted();
    const index = createRevertIndex({ git: serial.git });
    for (const cwd of repos.others) await index.refresh(cwd);
    expect(serial.passes()).toBe(1);
    const burst = counted();
    const fresh = createRevertIndex({ git: burst.git });
    await Promise.all(repos.others.map((cwd) => fresh.refresh(cwd)));
    expect(burst.passes()).toBe(1);
    expect(await index.hit(repos.others[0]!, "Edit docs/가이드.md.")).toMatchObject({ file: "docs/가이드.md", revert: { pr: 1596 } });
  });

  it("sees a revert fetched from a linked worktree without waiting out the interval", async () => {
    const repos = gitRepos();
    const { git, passes } = counted();
    const index = createRevertIndex({ git });
    await index.refresh(repos.main);
    const card = "Edit src/lens.ts.";
    expect(await index.hit(repos.main, card)).toBeUndefined();
    const upstream = join(repos.main, "..", "upstream");
    const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { windowsHide: true, encoding: "utf8" });
    run(join(repos.main, ".."), "clone", "-q", join(repos.main, "..", "origin.git"), upstream);
    for (const [text, message] of [["v1\n", "feat: lens (#1700)"], ["v0\n", "revert: lens (#1701)"]]) {
      mkdirSync(join(upstream, "src"), { recursive: true });
      writeFileSync(join(upstream, "src", "lens.ts"), text!);
      run(upstream, "add", "-A");
      run(upstream, "commit", "-qm", message!);
    }
    run(upstream, "push", "-q", "origin", "main");
    run(repos.old, "fetch", "-q", "origin");
    await index.refresh(repos.main);
    expect((await index.hit(repos.main, card))?.revert.pr).toBe(1701);
    expect(passes()).toBe(2);
  });

  it("checks a branch moved back against its own history, and reuses the log while no ref moves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revert-local-"));
    roots.push(dir);
    const run = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { windowsHide: true, encoding: "utf8" }).trim();
    const save = (text: string, message: string) => { writeFileSync(join(dir, "lens.ts"), text); run("add", "-A"); run("commit", "-qm", message); return run("rev-parse", "HEAD"); };
    run("init", "-q", "-b", "main");
    const a = save("v1\n", "feat: lens (#1700)");
    const { git, passes } = counted();
    const index = createRevertIndex({ git });
    const card = "Edit lens.ts.";
    await index.refresh(dir);
    expect(await index.hit(dir, card)).toBeUndefined();
    save("v0\n", "revert: lens (#1701)");
    await index.refresh(dir);
    expect((await index.hit(dir, card))?.revert.pr).toBe(1701);
    run("reset", "-q", "--hard", a);
    await index.refresh(dir);
    expect(await index.hit(dir, card)).toBeUndefined();
    await index.refresh(dir);
    await index.refresh(dir);
    expect(passes()).toBe(3);
  });

  it("sees a new ref in a reftable repo without waiting out the interval", async (context) => {
    const dir = mkdtempSync(join(tmpdir(), "revert-reftable-"));
    roots.push(dir);
    const run = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { windowsHide: true, encoding: "utf8" }).trim();
    try {
      run("init", "-q", "-b", "main", "--ref-format=reftable");
    } catch {
      return context.skip();
    }
    const save = (text: string, message: string) => { writeFileSync(join(dir, "lens.ts"), text); run("add", "-A"); run("commit", "-qm", message); };
    save("v1\n", "feat: lens (#1700)");
    const { git, passes } = counted();
    const index = createRevertIndex({ git });
    await index.refresh(dir);
    expect(await index.hit(dir, "Edit lens.ts.")).toBeUndefined();
    save("v0\n", "revert: lens (#1701)");
    await index.refresh(dir);
    expect((await index.hit(dir, "Edit lens.ts."))?.revert.pr).toBe(1701);
    expect(passes()).toBe(2);
  });

  it("reads folders only through node:fs/promises", () => {
    const source = readFileSync(new URL("./revert-index.ts", import.meta.url), "utf8");
    const sync = [...source.matchAll(/\b\w+Sync\b|from "node:fs"/g)].map((match) => match[0]);
    expect(sync, "sync fs in server/revert-index.ts blocks the whole server on a folder that never answers (a dead network share): use stat, readFile and readdir from node:fs/promises").toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("treats a common dir in another letter case as the same repo", async () => {
    const repos = gitRepos();
    const { git, passes } = counted();
    const index = createRevertIndex({ git });
    const flip = (path: string) => path.replace(/^[a-z]:/i, (drive) => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase());
    await Promise.all([index.refresh(repos.main), index.refresh(flip(repos.main))]);
    await index.refresh(flip(repos.main));
    expect(passes()).toBe(1);
  });

  it("gives no hit in a shallow repo and does not run git there", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".git", "shallow"), "1".repeat(40));
    const calls: string[][] = [];
    const index = createRevertIndex({ git: async (_cwd, args) => { calls.push(args); return BLUR_LOG; }, now: () => NOW });
    await index.refresh(dir);
    expect(await index.hit(dir, "electron/verify-cast.mjs")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("waits out the refresh interval after a failed pass instead of running git on every hit", async () => {
    const dir = repo();
    let now = NOW;
    let calls = 0;
    const index = createRevertIndex({ git: async () => { calls += 1; throw new Error("spawn git ENOENT"); }, now: () => now });
    await index.refresh(dir);
    for (let hit = 0; hit < 3; hit += 1) expect(await index.hit(dir, "electron/verify-cast.mjs")).toBeUndefined();
    await index.refresh(dir);
    expect(calls).toBe(1);
    now += 10 * 60_000;
    await index.refresh(dir);
    expect(calls).toBe(2);
  });
});
