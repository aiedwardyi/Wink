// Reverts in each repo's last 90 days and how often each file changed there, for the worker-launch gate.
// hit() never waits on git: it reads what the last pass found.
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { mapGit } from "./map-git.ts";
import { UNLANDED_REFRESH_MS } from "./unlanded.ts";

export type RevertGit = (cwd: string, args: string[]) => Promise<string>;

const DAY = 24 * 60 * 60_000;
const RECENT = 30 * DAY;
// server/index.ts has hundreds of commits in 90 days: a revert touching it says nothing about one card
const COLD = 10;
const LOG_LIMIT = 64 * 1024 * 1024;
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
const PATH = /[\w.@-]+(?:[\\/][\w.@-]+)+/g;

/** Newest first, as git log prints them. */
export function parseRevertLog(text: string): RevertLog {
  const commits = text.split("\x1e").slice(1).map((record) => {
    const [sha = "", at = "", subject = "", body = "", names = ""] = record.split("\x1f");
    return { sha, at: Number(at) * 1000, subject, body, files: [...new Set(names.split("\n").map((name) => name.trim()).filter(Boolean))] };
  });
  const counts = new Map<string, number>();
  const byPr = new Map<number, (typeof commits)[number]>();
  for (const commit of commits) {
    for (const file of commit.files) counts.set(file, (counts.get(file) ?? 0) + 1);
    const pr = OWN_PR.exec(commit.subject)?.[1];
    if (pr && !byPr.has(Number(pr))) byPr.set(Number(pr), commit);
  }
  const reverts = commits.filter((commit) => /^revert\b/i.test(commit.subject)).map((commit): Revert => {
    const own = OWN_PR.exec(commit.subject)?.[1];
    const pr = own ? Number(own) : undefined;
    const said = [commit.subject, ...commit.body.split("\n").filter((line) => /\brevert/i.test(line))].join("\n");
    const prs = [...new Set([...said.matchAll(PR)].map((match) => Number(match[1])))].filter((number) => number !== pr);
    const shas = new Set([...said.matchAll(SHA)].map((match) => match[0].toLowerCase()).filter((sha) => /[a-f]/.test(sha)));
    const undone = prs.map((number) => byPr.get(number)).find(Boolean) ?? commits.find((other) => [...shas].some((sha) => other.sha.startsWith(sha)));
    if (undone) shas.add(undone.sha);
    return { sha: commit.sha, at: commit.at, subject: commit.subject, ...pr && { pr }, files: commit.files, undid: { prs, shas: [...shas], ...undone && { subject: undone.subject } } };
  });
  return { reverts, counts };
}

/** The newest revert in the last 30 days that changed a seldom-changed file the card names, when the card names neither it nor what it undid. */
export function revertHit(log: RevertLog, card: string, now: number): RevertHit | undefined {
  const named = [...card.matchAll(PATH)].map((match) => match[0].replaceAll("\\", "/").replace(/\.+$/, "").toLowerCase());
  const prs = new Set([...card.matchAll(PR)].map((match) => Number(match[1])));
  const hexes = [...card.matchAll(SHA)].map((match) => match[0].toLowerCase());
  const shaCited = (sha: string) => hexes.some((hex) => sha.startsWith(hex) || hex.startsWith(sha));
  for (const revert of log.reverts) {
    if (revert.at > now || now - revert.at > RECENT) continue;
    if ((revert.pr && prs.has(revert.pr)) || shaCited(revert.sha) || revert.undid.prs.some((pr) => prs.has(pr)) || revert.undid.shas.some(shaCited)) continue;
    const file = revert.files.find((file) => {
      const lower = file.toLowerCase();
      return (log.counts.get(file) ?? 0) <= COLD && named.some((path) => path === lower || path.endsWith(`/${lower}`));
    });
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

/** The git common dir the cwd's checkout shares with its worktrees, and its HEAD, read with no git spawn. */
export function gitHome(cwd: string): { common: string; key: string } | undefined {
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
    // a packed ref reads empty here: the refresh interval catches its moves
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    return { common, key: `${head}\0${ref ? readText(join(common, ref)) ?? "" : ""}` };
  }
}

export function createRevertIndex(deps: { git?: RevertGit; now?: () => number } = {}) {
  const git = deps.git ?? ((cwd, args) => mapGit(cwd, args, LOG_LIMIT));
  const now = deps.now ?? Date.now;
  const repos = new Map<string, { key: string; at: number; log: RevertLog }>();
  const running = new Map<string, Promise<void>>();

  function refresh(cwd: string, home = gitHome(cwd)): Promise<void> {
    if (!home) return Promise.resolve();
    const known = repos.get(home.common);
    if (known && known.key === home.key && now() - known.at < UNLANDED_REFRESH_MS) return Promise.resolve();
    const prior = running.get(home.common);
    if (prior) return prior;
    const job = git(cwd, ["log", "--no-color", "--no-renames", "--since=90.days", "--name-only", FORMAT, "--"])
      .then((text) => { repos.set(home.common, { key: home.key, at: now(), log: parseRevertLog(text) }); }, () => {})
      .finally(() => running.delete(home.common));
    running.set(home.common, job);
    return job;
  }

  return {
    refresh,
    hit(cwd: string, card: string): RevertHit | undefined {
      const home = gitHome(cwd);
      if (!home) return undefined;
      void refresh(cwd, home);
      const known = repos.get(home.common);
      return known ? revertHit(known.log, card, now()) : undefined;
    },
  };
}
