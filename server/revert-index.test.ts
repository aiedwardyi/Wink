import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createRevertIndex, gitHome, parseRevertLog, revertHit } from "./revert-index.ts";

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

  it("finds the common dir of a worktree and nothing outside a repo", () => {
    const main = repo();
    const worktree = mkdtempSync(join(tmpdir(), "revert-wt-"));
    const own = join(main, ".git", "worktrees", "wt");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(own, "commondir"), "../..\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${own}\n`);
    mkdirSync(join(worktree, "src"));
    expect(gitHome(join(worktree, "src"))?.common).toBe(join(main, ".git"));
    expect(gitHome(main)).toEqual({ common: join(main, ".git"), key: `ref: refs/heads/main\0${"1".repeat(40)}` });
    expect(gitHome(mkdtempSync(join(tmpdir(), "revert-none-")))).toBeUndefined();
    expect(gitHome("")).toBeUndefined();
    expect(gitHome("relative/dir")).toBeUndefined();
  });

  it("runs one git pass per repo and runs again only when HEAD moves or the interval passes", async () => {
    const dir = repo();
    let now = NOW;
    const calls: string[][] = [];
    const index = createRevertIndex({ git: async (_cwd, args) => { calls.push(args); return BLUR_LOG; }, now: () => now });
    expect(index.hit(dir, "electron/verify-cast.mjs")).toBeUndefined();
    await index.refresh(dir);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(["log", "--since=90.days", "--name-only"]));
    expect(index.hit(dir, "electron/verify-cast.mjs")?.revert.pr).toBe(1595);
    await index.refresh(dir);
    expect(calls).toHaveLength(1);
    writeFileSync(join(dir, ".git", "refs", "heads", "main"), "2".repeat(40));
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
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/other\n");
    await expect(index.refresh(dir)).resolves.toBeUndefined();
    expect(index.hit(dir, "electron/verify-cast.mjs")?.revert.pr).toBe(1595);
  });
});
