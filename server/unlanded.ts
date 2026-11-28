// PRs that worker reports name and that are not in the user's installed build.
// take() never waits on gh: it returns what the last refresh found.
import { z } from "zod";

import { parsePaneNote } from "../shared/pane-note.ts";
import { ghRun, type MapGh } from "./map-pr.ts";

export const UNLANDED_REFRESH_MS = 10 * 60_000;
const SHOWN = 8;
const WORK_SHOWN = 4;
const REPORTS_READ = 40;
const TITLE_MAX = 40;
const HOUR = 60 * 60_000;
// Only Wink's own repo has a provable installed version: the v<app version> tag.
export const APP_REPO = "aiedwardyi/wink";

const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi;
const PR_REF = /\bPR\s*#?(\d{1,6})\b/gi;
const BRANCH = / branch=(\S+)/;
const SHA = / sha=([0-9a-f]{7,40})/;
const NOT_PR_BRANCH = new Set(["none", "HEAD", "main", "master"]);
export const NOT_FOUND = /no pull requests found|Could not resolve to a PullRequest|HTTP 404/i;

const viewSchema = z.object({
  number: z.number(), title: z.string(), url: z.string(), state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean().optional(), mergeCommit: z.object({ oid: z.string() }).nullish(),
});

export interface ReportedPr { at: number; repo?: string; number?: number; branch?: string; sha?: string }

export interface UnlandedPr {
  repo: string;
  number: number;
  title: string;
  state: "open" | "draft" | "merged, not released" | "merged, not in your build";
  /** first report naming it */
  at: number;
}

type ReportRow = { kind?: string; text?: string; at?: number };

const isReport = (message: ReportRow) => message.kind === "note" && message.at !== undefined && Boolean(message.text) && Boolean(parsePaneNote(message.text!).status);

/** The rows reportedPrs reads, newest first: through the newest REPORTS_READ reports, so boot's worker can read them off the main thread. */
export function* reportNotes<T extends ReportRow>(newestFirst: Iterable<T>): Generator<T> {
  let reports = 0;
  for (const message of newestFirst) {
    if (reports >= REPORTS_READ) return;
    yield message;
    if (isReport(message)) reports++;
  }
}

/** PRs named in the newest orbit-msg reports, by URL, "PR n", or else the report's branch. */
export function reportedPrs(newestFirst: Iterable<ReportRow>): ReportedPr[] {
  const refs: ReportedPr[] = [];
  for (const message of reportNotes(newestFirst)) {
    if (!isReport(message)) continue;
    const note = parsePaneNote(message.text!);
    const at = message.at!;
    const found: ReportedPr[] = [];
    for (const match of note.body.matchAll(PR_URL)) found.push({ at, repo: match[1]!.toLowerCase(), number: Number(match[2]) });
    for (const match of note.body.replace(PR_URL, "").matchAll(PR_REF)) found.push({ at, number: Number(match[1]) });
    const branch = BRANCH.exec(message.text!.split("\n", 1)[0]!)?.[1];
    if (!found.length && branch && !NOT_PR_BRANCH.has(branch)) found.push({ at, branch, sha: SHA.exec(message.text!.split("\n", 1)[0]!)?.[1] });
    refs.push(...found);
  }
  return refs;
}

const age = (ms: number) => ms < HOUR ? "<1h" : ms < 48 * HOUR ? `${Math.floor(ms / HOUR)}h` : `${Math.floor(ms / (24 * HOUR))}d`;

const clip = (text: string) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= TITLE_MAX ? clean : `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…`;
};

/** Oldest first, so anything waiting a day or more leads. Empty when none. */
export function unlandedHeader(prs: readonly UnlandedPr[], now: number): string {
  if (!prs.length) return "";
  const ordered = prs.toSorted((left, right) => left.at - right.at);
  // the full owner/repo, so a bot never resolves the number against its own folder's repo
  const repos = new Set(prs.map((pr) => pr.repo));
  const only = repos.size === 1 ? prs[0]!.repo : "";
  const items = ordered.slice(0, SHOWN).map((pr) => {
    const id = `${only ? "" : pr.repo}#${pr.number}`;
    return `${id} ${clip(pr.title)} (${age(now - pr.at)}${pr.state === "open" ? "" : `, ${pr.state}`})`;
  });
  const more = ordered.length > SHOWN ? `; +${ordered.length - SHOWN} more` : "";
  const count = prs.length === 1 ? "1 PR" : `${prs.length} PRs`;
  return `[Wink unlanded - ${count}${only ? ` in ${only}` : ""} not in the user's build: ${items.join("; ")}${more}. Before saying fixed or asking them to test, check it is merged and released.]`;
}

export interface UnlandedWorkDeps {
  /** the thread's notes newest first, read lazily so a long thread is never parsed whole */
  reportsBack: (threadId: string) => Iterable<{ kind?: string; text?: string; at?: number }>;
  /** where gh resolves a PR the report names without its repo: the folder this task pinned */
  repoDir: (botId: string, threadId: string) => string | undefined;
  /** the installed app version; empty when unknown */
  version: string;
  gh?: MapGh;
  now?: () => number;
}

export interface UnlandedWork {
  /** The header this task's own reports built, "" when none. No I/O. */
  take(threadId: string): string;
  /** Each change its reports name, newest first: merged, open PR, or unfinished branch. No I/O. */
  work(threadId: string): string;
  /** `reports`: rows boot's worker already read (reportNotes), used in place of reportsBack for this pass. */
  refresh(botId: string, threadId: string, reports?: Iterable<ReportRow>): Promise<void>;
}

type Landed = { repo: string; number: number; title: string };
// landed: merged and in the build, so off the unlanded header but still the bot's own work
type Lookup = { at: number; final: boolean; pr: Omit<UnlandedPr, "at"> | null; landed?: Landed; noPr?: true };
type WorkItem = { at: number; text: string };

/** Newest first, WORK_SHOWN of them, then a count of the rest. */
export function workLine(items: readonly WorkItem[]): string {
  if (!items.length) return "";
  const ordered = items.toSorted((left, right) => right.at - left.at);
  const more = ordered.length > WORK_SHOWN ? `; +${ordered.length - WORK_SHOWN} older` : "";
  return `Your work, newest ${WORK_SHOWN}: ${ordered.slice(0, WORK_SHOWN).map((item) => item.text).join("; ")}${more}`;
}

export function createUnlandedWork(deps: UnlandedWorkDeps): UnlandedWork {
  const gh = deps.gh ?? ghRun;
  const now = deps.now ?? Date.now;
  const lookups = new Map<string, Lookup>();
  const unlanded = new Map<string, UnlandedPr[]>();
  const works = new Map<string, WorkItem[]>();
  const running = new Map<string, Promise<void>>();
  // asked again mid-run: the running pass read the reports before the new one landed
  const stale = new Set<string>();

  // Only a merge settles a PR, and the installed version is fixed for this process; a closed PR can reopen.
  async function lookup(ref: ReportedPr, dir: string | undefined): Promise<Lookup> {
    const at = now();
    const target = ref.number ? String(ref.number) : ref.branch!;
    try {
      const raw: unknown = JSON.parse(await gh(dir ?? process.cwd(), [
        "pr", "view", target, ...ref.repo ? ["--repo", ref.repo] : [], "--json", "number,title,url,state,isDraft,mergeCommit",
      ]));
      const view = viewSchema.parse(raw);
      const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(view.url)?.[1]?.toLowerCase();
      if (!repo) return { at, final: true, pr: null };
      if (view.state === "CLOSED") return { at, final: false, pr: null };
      const base = { repo, number: view.number, title: view.title };
      if (view.state === "OPEN") return { at, final: false, pr: { ...base, state: view.isDraft ? "draft" : "open" } };
      const { build, final } = await inBuild(repo, view.mergeCommit?.oid);
      return build === true ? { at, final, pr: null, landed: base } : { at, final, pr: { ...base, state: build === false ? "merged, not in your build" : "merged, not released" } };
    } catch (error) {
      // a branch can get its PR after the report; a number that names no PR never will
      const missing = NOT_FOUND.test(String(error));
      const failed: Lookup = { at, final: Boolean(ref.number) && missing, pr: null };
      if (!ref.number && missing) failed.noPr = true;
      return failed;
    }
  }

  /** build is null when the installed build can't be compared; not final when that may change */
  async function inBuild(repo: string, oid: string | undefined): Promise<{ build: boolean | null; final: boolean }> {
    if (repo !== APP_REPO || !deps.version || !oid) return { build: null, final: true };
    try {
      const status = (await gh(process.cwd(), ["api", `repos/${repo}/compare/v${deps.version}...${oid}`, "--jq", ".status"])).trim();
      const build = status === "behind" || status === "identical" ? true : status === "ahead" || status === "diverged" ? false : null;
      return { build, final: build !== null };
    } catch (error) {
      // a dev build has no tag; anything else may be a dropped connection
      return { build: null, final: NOT_FOUND.test(String(error)) };
    }
  }

  async function run(botId: string, threadId: string, reports?: Iterable<ReportRow>) {
    const dir = deps.repoDir(botId, threadId);
    const found = new Map<string, UnlandedPr>();
    const work = new Map<string, WorkItem>();
    for (const ref of reportedPrs(reports ?? deps.reportsBack(threadId))) {
      if (!ref.repo && !dir) continue;
      const key = `${ref.repo ?? dir}|${ref.number ?? ref.branch}`;
      let entry = lookups.get(key);
      // a branch can open a new PR after its last one settles; only a PR number stays settled
      const settled = entry?.final === true && Boolean(ref.number);
      if (!entry || (!settled && now() - entry.at >= UNLANDED_REFRESH_MS)) lookups.set(key, entry = await lookup(ref, dir));
      const pr = entry.pr ?? entry.landed;
      const id = pr ? `${pr.repo}#${pr.number}` : `branch ${ref.branch}`;
      if (!work.has(id) && (pr || entry.noPr)) {
        const state = !entry.pr ? "merged" : entry.pr.state.startsWith("merged") ? entry.pr.state : "open PR";
        work.set(id, { at: ref.at, text: pr ? `${id} ${clip(pr.title)} (${state})` : `${ref.branch}${ref.sha ? ` ${ref.sha.slice(0, 7)}` : ""} (unfinished branch, no PR)` });
      }
      if (!entry.pr) continue;
      const seen = found.get(id);
      if (!seen || ref.at < seen.at) found.set(id, { ...entry.pr, at: ref.at });
    }
    unlanded.set(threadId, [...found.values()]);
    works.set(threadId, [...work.values()]);
  }

  function refresh(botId: string, threadId: string, reports?: Iterable<ReportRow>): Promise<void> {
    const prior = running.get(threadId);
    if (prior) {
      stale.add(threadId);
      return prior;
    }
    const job = (async () => {
      // a rerun reads the store: the given rows predate the report that asked again
      for (let rows = reports; ; rows = undefined) {
        stale.delete(threadId);
        await run(botId, threadId, rows).catch(() => {});
        if (!stale.has(threadId)) break;
      }
    })().finally(() => running.delete(threadId));
    running.set(threadId, job);
    return job;
  }

  return {
    take(threadId) {
      return unlandedHeader(unlanded.get(threadId) ?? [], now());
    },
    work(threadId) {
      return workLine(works.get(threadId) ?? []);
    },
    refresh,
  };
}
