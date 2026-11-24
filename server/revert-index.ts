// Reverts in each repo's last 90 days and how often each file changed there, for the worker-launch gate.
// hit() never waits on git: it reads what the last pass found.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { mapGit } from "./map-git.ts";
import { UNLANDED_REFRESH_MS } from "./unlanded.ts";

export type RevertGit = (cwd: string, args: string[]) => Promise<string>;

const DAY = 24 * 60 * 60_000;
const RECENT = 30 * DAY;
// server/index.ts has hundreds of commits in 90 days: a revert touching it says nothing about one card
const COLD = 10;
const LOG_LIMIT = 64 * 1024 * 1024;
// a hit stats every ref folder, so it looks at most this often; boot and turn-settle refreshes always look
const REFS_CHECK_MS = 5_000;
const TITLE_MAX = 80;
const FORMAT = "--format=%x1e%H%x1f%ct%x1f%s%x1f%b%x1f";

export interface Revert {
  sha: string;
  at: number;
  subject: string;
  pr?: number;
  files: string[];
  undid: { prs: number[]; shas: string[]; subject?: string };
}

export interface RevertLog { reverts: Revert[]; counts: Map<string, number> }
export interface RevertHit { file: string; revert: Revert }

const OWN_PR = /\(#(\d+)\)\s*$/;
const SHA = /\b[0-9a-f]{7,40}\b/gi;
const PR = /#(\d+)\b/g;
const REVERT = /^reverts?\b/i;
const EMPTY: RevertLog = { reverts: [], counts: new Map() };

/** Newest first, as git log prints them. */
export function parseRevertLog(text: string): RevertLog {
  const commits = text.split("\x1e").slice(1).map((record) => {
    const [sha = "", at = "", subject = "", body = "", names = ""] = record.split("\x1f");
    return { sha, at: Number(at) * 1000, subject, body, files: [...new Set(names.split("\n").map((name) => name.trim()).filter(Boolean))] };
  });
  const counts = new Map<string, number>();
  // oldest wins: a direct "revert: undo (#1587)" ends with the PR it undid, not its own
  const byPr = new Map<number, (typeof commits)[number]>();
  for (const commit of commits) {
    for (const file of commit.files) counts.set(file, (counts.get(file) ?? 0) + 1);
    const pr = OWN_PR.exec(commit.subject)?.[1];
    if (pr) byPr.set(Number(pr), commit);
  }
  const reverts: Revert[] = [];
  const putBack = new Set<string>();
  for (const commit of commits) {
    if (!REVERT.test(commit.subject) || putBack.has(commit.sha)) continue;
    const own = Number(OWN_PR.exec(commit.subject)?.[1]);
    const pr = byPr.get(own) === commit ? own : undefined;
    const said = [commit.subject, ...commit.body.split("\n").filter((line) => /\brevert/i.test(line))].join("\n");
    const prs = [...new Set([...said.matchAll(PR)].map((match) => Number(match[1])))].filter((number) => number !== pr);
    const shas = new Set([...said.matchAll(SHA)].map((match) => match[0].toLowerCase()).filter((sha) => /[a-f]/.test(sha)));
    const undone = [...prs].reverse().map((number) => byPr.get(number)).find(Boolean) ?? commits.find((other) => [...shas].some((sha) => other.sha.startsWith(sha)));
    // a revert of a revert puts the work back
    const putsBack = undone && REVERT.test(undone.subject);
    if (putsBack) putBack.add(undone.sha);
    if (putsBack || /^revert\s+"revert\b/i.test(commit.subject)) continue;
    const undonePr = Number(OWN_PR.exec(undone?.subject ?? "")?.[1]);
    if (undonePr && !prs.includes(undonePr)) prs.push(undonePr);
    if (undone) shas.add(undone.sha);
    reverts.push({ sha: commit.sha, at: commit.at, subject: commit.subject, ...pr && { pr }, files: commit.files, undid: { prs, shas: [...shas], ...undone && { subject: undone.subject } } });
  }
  return { reverts, counts };
}

/** The card names the repo file whole, or ends a longer path with it when the file is in a folder or the path is absolute. */
function names(card: string, file: string): boolean {
  for (let at = card.indexOf(file); at >= 0; at = card.indexOf(file, at + 1)) {
    if (/^(?:[\p{L}\p{N}_@/-]|\.[\p{L}\p{N}_])/u.test(card.slice(at + file.length, at + file.length + 2))) continue;
    const before = card[at - 1] ?? " ";
    if (before === "/" ? file.includes("/") || /^(?:[a-z]:|~)?\//.test(/[^\s"'`<>(]*$/.exec(card.slice(0, at))![0]) : !/[\p{L}\p{N}_@.-]/u.test(before)) return true;
  }
  return false;
}

/** The newest revert in the last 30 days that changed a seldom-changed file the card names, when the card names neither it nor what it undid. */
export function revertHit(log: RevertLog, card: string, now: number): RevertHit | undefined {
  const text = card.replaceAll("\\", "/").toLowerCase();
  const prs = new Set([...card.matchAll(PR)].map((match) => Number(match[1])));
  const hexes = [...card.matchAll(SHA)].map((match) => match[0].toLowerCase());
  const shaCited = (sha: string) => hexes.some((hex) => sha.startsWith(hex) || hex.startsWith(sha));
  for (const revert of log.reverts) {
    if (revert.at > now || now - revert.at > RECENT) continue;
    if ((revert.pr && prs.has(revert.pr)) || shaCited(revert.sha) || revert.undid.prs.some((pr) => prs.has(pr)) || revert.undid.shas.some(shaCited)) continue;
    const file = revert.files.find((file) => (log.counts.get(file) ?? 0) <= COLD && names(text, file.toLowerCase()));
    if (file) return { file, revert };
  }
  return undefined;
}

const clip = (text: string) => text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1).trimEnd()}…`;
const revertId = (revert: Revert) => revert.pr ? `#${revert.pr}` : revert.sha.slice(0, 9);

export function revertHoldText(card: string, { file, revert }: RevertHit): string {
  const undid = revert.undid.prs.length ? revert.undid.prs.map((pr) => `#${pr}`).join(", ") : revert.undid.shas.map((sha) => sha.slice(0, 9)).join(", ");
  const what = undid ? `it undid ${undid}${revert.undid.subject ? ` "${clip(revert.undid.subject)}"` : ""}` : "see what it undid";
  return `Held (look first): ${card} names ${file}, which revert ${revertId(revert)} (${new Date(revert.at).toISOString().slice(5, 10)}) changed; ${what}. Read both, then add a "Look-first:" line under ## Already built saying how this card differs. Then send the spawn again.`;
}

/** The ndjson row a would-hold logs. */
export function revertHoldRow(card: string, { file, revert }: RevertHit) {
  return { card, file, revert: { pr: revert.pr, sha: revert.sha, subject: revert.subject }, undid: revert.undid };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The git common dir the cwd's checkout shares with its worktrees and the refs to log, read with no git spawn. */
export function gitHome(cwd: string): { common: string; refs: string; shallow: boolean } | undefined {
  if (!isAbsolute(cwd) && !win32.isAbsolute(cwd)) return undefined;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dot = join(dir, ".git");
    let own;
    try {
      own = statSync(dot);
    } catch {
      if (dirname(dir) === dir) return undefined;
      continue;
    }
    const gitDir = own.isDirectory() ? dot : resolve(dir, /^gitdir:\s*(.+)$/m.exec(readText(dot) ?? "")?.[1]?.trim() ?? "");
    const shared = readText(join(gitDir, "commondir"));
    const common = shared ? resolve(gitDir, shared) : gitDir;
    const head = readText(join(gitDir, "HEAD"));
    if (head === undefined) return undefined;
    const shallow = existsSync(join(common, "shallow"));
    // every worktree logs the same refs, so one forked before a revert never hides it
    const origin = /^\s*\[remote "origin"\]/m.test(readText(join(common, "config")) ?? "");
    return { common, refs: origin ? "--remotes=origin" : "--branches", shallow };
  }
}

const folders = new Map<string, { at: number; subs: string[] }>();

/** Changes when any worktree moves a ref the log reads: git writes a loose ref as a lock file renamed into its folder. */
function refsKey(common: string, refs: string): string {
  const times = [mtime(join(common, "packed-refs"))];
  const walk = (dir: string) => {
    const at = mtime(dir);
    times.push(at);
    let known = folders.get(dir);
    if (known?.at !== at) {
      let subs: string[] = [];
      try {
        subs = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
      } catch {}
      known = { at, subs };
      folders.set(dir, known);
    }
    for (const sub of known.subs) walk(sub);
  };
  walk(join(common, refs === "--branches" ? "refs/heads" : "refs/remotes/origin"));
  return times.join(",");
}

export function createRevertIndex(deps: { git?: RevertGit; now?: () => number } = {}) {
  const git = deps.git ?? ((cwd, args) => mapGit(cwd, args, LOG_LIMIT));
  const now = deps.now ?? Date.now;
  const repos = new Map<string, { key: string; at: number; checked: number; log: RevertLog }>();
  const running = new Map<string, Promise<void>>();
  const repoId = (common: string) => process.platform === "win32" ? common.toLowerCase() : common;

  function refresh(cwd: string, home = gitHome(cwd)): Promise<void> {
    // a shallow history undercounts how often a file changed
    if (!home || home.shallow) return Promise.resolve();
    const id = repoId(home.common);
    const key = refsKey(home.common, home.refs);
    const known = repos.get(id);
    if (known) known.checked = now();
    if (known?.key === key && now() - known.at < UNLANDED_REFRESH_MS) return Promise.resolve();
    const prior = running.get(id);
    if (prior) return prior;
    // a failed pass keeps the last one until the interval passes
    const job = git(cwd, ["-c", "core.quotePath=false", "log", "--no-color", "--no-renames", "--since=90.days", "--name-only", FORMAT, home.refs, "--"])
      .then(parseRevertLog, () => known?.log ?? EMPTY)
      .then((log) => { repos.set(id, { key, at: now(), checked: now(), log }); })
      .finally(() => running.delete(id));
    running.set(id, job);
    return job;
  }

  return {
    refresh,
    hit(cwd: string, card: string): RevertHit | undefined {
      const home = gitHome(cwd);
      if (!home || home.shallow) return undefined;
      const known = repos.get(repoId(home.common));
      if (!known || now() - known.checked >= REFS_CHECK_MS) void refresh(cwd, home);
      return known ? revertHit(known.log, card, now()) : undefined;
    },
  };
}
