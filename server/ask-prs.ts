// Building asks whose ref names GitHub PRs close as done once all of them merge. take() never waits on gh: it uses what the last check found.
import { z } from "zod";

import { redactSecretsInText } from "../shared/redact.ts";
import { ghRun, type MapGh } from "./map-pr.ts";
import type { Message } from "./store.ts";
import type { TaskAsk } from "./task-asks.ts";
import { NOT_FOUND, UNLANDED_REFRESH_MS } from "./unlanded.ts";

const PR_URL = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#][^\s;,+]*)?/gi;
const REPO_PR = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const PR_REF = /\bPR\s*#?(\d{1,6})\b/gi;
const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+)/i;
const SHA = /\b[0-9a-f]{7,40}\b/gi;
const NOT_REPO = /not a git repository/i;
const REASON_MAX = 120;
const viewSchema = z.object({ state: z.enum(["OPEN", "MERGED", "CLOSED"]), mergedAt: z.string().nullish() });

type Pr = { repo?: string; number: number };
type Check = { at: number; state: "merged" | "open" | "missing" | "failed"; reason?: string; mergedAt?: number };
export type MergedPr = Pr & { mergedAt?: number };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string) => {
  const clean = oneLine(text);
  return clean.length <= REASON_MAX ? clean : `${clean.slice(0, REASON_MAX - 1).trimEnd()}…`;
};

/** Every PR an ask's ref names, by URL, owner/repo#n or "PR n". */
export function refPrs(ref: string | undefined): Pr[] {
  const prs: Pr[] = [];
  const add = (pr: Pr) => {
    if (!prs.some((seen) => seen.repo === pr.repo && seen.number === pr.number)) prs.push(pr);
    return " ";
  };
  const rest = (ref ?? "")
    .replace(PR_URL, (_, repo: string, number: string) => add({ repo: repo.toLowerCase(), number: Number(number) }))
    .replace(REPO_PR, (_, repo: string, number: string) => add({ repo: repo.toLowerCase(), number: Number(number) }));
  for (const match of rest.matchAll(PR_REF)) add({ number: Number(match[1]) });
  return prs;
}

/** The first PR an ask's ref names; null for any other ref. */
export function askPr(ref: string | undefined): Pr | null {
  return refPrs(ref)[0] ?? null;
}

/** Repos named by PR links and owner/repo#n refs, lowercase, first seen first. A plain github.com/o/r link names none: reports cite other repos' docs. */
export function reposIn(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => refPrs(text).flatMap((pr) => pr.repo ? [pr.repo] : [])))];
}

/** The GitHub repo a git remote URL points at, lowercase; undefined for any other. */
export function remoteRepo(url: string): string | undefined {
  return GITHUB_REMOTE.exec(url)?.[1]!.replace(/\.git$/i, "").toLowerCase();
}

/** Repos each bot works in, found off the send path; get() never waits. Remotes from discover are saved and only added to, so a refresh that finds less keeps them; repos cited in asks and reports last until the next refresh, so a cited link goes when its report leaves. get() is undefined until cite() or refresh() has read the cited ones. */
export function createKnownRepos(deps: { discover: (botId: string) => Promise<string[]>; cited: (botId: string, reports?: readonly Message[]) => Promise<string[]>; saved: (botId: string) => readonly string[]; save: (botId: string, repos: string[]) => void }) {
  const cited = new Map<string, string[]>();
  return {
    get: (botId: string): string[] | undefined => cited.has(botId) ? [...new Set([...deps.saved(botId), ...cited.get(botId)!])] : undefined,
    /** Reads the cited repos once, from these reports if given; a refresh that already read them wins. */
    async cite(botId: string, reports?: readonly Message[]): Promise<void> {
      const repos = await deps.cited(botId, reports).catch(() => undefined);
      if (repos && !cited.has(botId)) cited.set(botId, repos);
    },
    async refresh(botId: string): Promise<void> {
      const found = await deps.discover(botId).catch(() => []);
      const repos = await deps.cited(botId).catch(() => undefined);
      if (repos) cited.set(botId, repos);
      // read after the awaits: an overlapping refresh may have saved since this one began
      const saved = deps.saved(botId);
      const next = [...new Set([...saved, ...found])];
      if (next.length > saved.length) deps.save(botId, next);
    },
  };
}

/** The asks with these ids, if still building, marked done. */
export function withClosed(asks: readonly TaskAsk[] | undefined, ids: readonly string[], now: number): TaskAsk[] {
  return (asks ?? []).map((ask) => ids.includes(ask.id) && ask.status === "building" ? { ...ask, status: "done" as const, changedAt: now } : ask);
}

/** What a ref says beyond its PRs, SHAs and "merged": a step not done yet, or "". */
export function stepLeft(ref: string | undefined): string {
  const words = oneLine(ref ?? "").replace(PR_URL, " ").replace(REPO_PR, " ").replace(PR_REF, " ").replace(SHA, " ").replace(/\b(?:merged|and)\b/gi, " ");
  return words.split(/[;,+]/).map((part) => oneLine(part).replace(/^[\s:.-]+|[\s:.-]+$/g, "")).filter((part) => /\p{L}/u.test(part)).join("; ");
}

/** The line a turn carries once an ask's PRs all merged: closed, or kept building with the step its ref still names. */
export function closedAskLine(ask: TaskAsk): string {
  const ref = oneLine(ask.ref ?? "");
  const prs = refPrs(ref).map((pr) => pr.repo ? `${pr.repo}#${pr.number}` : `PR ${pr.number}`).join(" and ");
  const step = stepLeft(ref);
  return step
    ? `[Wink kept ${ask.id} "${oneLine(ask.ask)}" building: ${prs} merged; step left: ${step}. Close it once that step is done.]`
    : `[Wink closed ${ask.id} "${oneLine(ask.ask)}": ${prs} merged. Its ref was "${ref}".]`;
}

export interface AskPrsDeps {
  /** where gh resolves "PR n" with no repo: the folder this task pinned */
  repoDir: (botId: string, threadId: string) => string | undefined;
  /** where a bare "PR n" is looked up when that folder is not a git repo; undefined while not read yet, which holds it unchecked */
  repos?: (botId: string) => readonly string[] | undefined;
  gh?: MapGh;
  now?: () => number;
}

export function createAskPrs(deps: AskPrsDeps) {
  const gh = deps.gh ?? ghRun;
  const now = deps.now ?? Date.now;
  const checked = new Map<string, Check>();
  const running = new Map<string, Promise<void>>();
  // a folder gh found is not a git repo is not asked again; its "PR n" goes to the known repos
  const notRepo = new Set<string>();
  // changedAt of each ask take() closed, so any bot edit before the turn lands keeps it
  const taken = new Map<string, Map<string, number>>();
  const pending = new Map<string, { turnId: string; changed: Map<string, number | undefined> }>();
  const noted = new Map<string, string>();
  const told = new Map<string, string>();

  async function check(key: string, number: number, repo: string | undefined, dir: string | undefined, botId: string): Promise<void> {
    let result: Check;
    try {
      const view = viewSchema.parse(JSON.parse(await gh(dir ?? process.cwd(), ["pr", "view", String(number), ...repo ? ["--repo", repo] : [], "--json", "state,mergedAt"])));
      const mergedAt = Date.parse(view.mergedAt ?? "");
      result = { at: now(), state: view.state === "MERGED" ? "merged" : "open" };
      if (Number.isFinite(mergedAt)) result.mergedAt = mergedAt;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      result = NOT_FOUND.test(text) ? { at: now(), state: "missing" } : { at: now(), state: "failed", reason: clip(redactSecretsInText(text)) };
      if (!repo && dir && NOT_REPO.test(text)) {
        notRepo.add(dir);
        await Promise.all((deps.repos?.(botId) ?? []).map((known) => look(`${known}|${number}`, number, known, undefined, botId, true).running));
      }
    }
    checked.set(key, result);
  }

  function look(key: string, number: number, repo: string | undefined, dir: string | undefined, botId: string, start: boolean) {
    const last = checked.get(key);
    if (start && !running.has(key) && last?.state !== "merged" && (!last || now() - last.at >= UNLANDED_REFRESH_MS)) {
      running.set(key, check(key, number, repo, dir, botId).finally(() => running.delete(key)));
    }
    return { last, running: running.get(key) };
  }

  /** One PR's state: the folder's repo for a bare "PR n", else the one known repo that holds it. undefined while unchecked. */
  function placed(botId: string, dir: string | undefined, pr: Pr, start: boolean): Check | undefined {
    if (pr.repo) {
      const last = look(`${pr.repo}|${pr.number}`, pr.number, pr.repo, undefined, botId, start).last;
      return last?.state === "missing" ? { at: 0, state: "failed", reason: `${pr.repo}#${pr.number} not found` } : last;
    }
    if (dir && !notRepo.has(dir)) {
      const local = look(`${dir}|${pr.number}`, pr.number, undefined, dir, botId, start).last;
      if (!notRepo.has(dir)) return local;
    }
    const repos = deps.repos ? deps.repos(botId) : [];
    if (!repos) return undefined;
    if (!repos.length) {
      return { at: 0, state: "failed", reason: dir ? `${dir} is not a git repo and no repo it works in is known yet` : `no folder or known repo to look PR ${pr.number} up in` };
    }
    const found = repos.map((repo) => ({ repo, last: look(`${repo}|${pr.number}`, pr.number, repo, undefined, botId, start).last }));
    const failed = found.filter(({ last }) => last?.state === "failed");
    if (failed.length) return { at: 0, state: "failed", reason: failed.map(({ repo, last }) => `${repo}: ${last!.reason}`).join("; ") };
    if (found.some(({ last }) => !last)) return undefined;
    const held = found.filter(({ last }) => last!.state !== "missing");
    if (held.length > 1 && held.some(({ last }) => last!.state === "merged")) return { at: 0, state: "failed", reason: `PR ${pr.number} is in ${held.map(({ repo }) => repo).join(" and ")}` };
    if (!held.length) return { at: 0, state: "failed", reason: `PR ${pr.number} is in none of ${repos.join(", ")}` };
    return held[0]!.last;
  }

  function verdicts(botId: string, threadId: string, asks: readonly TaskAsk[] | undefined, start: boolean) {
    const dir = deps.repoDir(botId, threadId);
    return (asks ?? []).flatMap((ask) => {
      const prs = ask.status === "building" ? refPrs(ask.ref) : [];
      if (!prs.length) return [];
      const each = prs.map((pr) => placed(botId, dir, pr, start));
      const failed = each.filter((last) => last?.state === "failed");
      if (failed.length) return [{ ask, merged: false, reason: failed.map((last) => last!.reason).join("; ") }];
      return [{ ask, merged: each.every((last) => last?.state === "merged"), reason: "" }];
    });
  }

  const failed = (botId: string, threadId: string, asks: readonly TaskAsk[] | undefined) =>
    verdicts(botId, threadId, asks, false).flatMap(({ ask, reason }) => reason ? [{ id: ask.id, reason }] : []);

  const once = (seen: Map<string, string>, threadId: string, line: string, full: boolean) => {
    if (line === (seen.get(threadId) ?? "") && !full) return "";
    seen.set(threadId, line);
    return line;
  };

  return {
    /** Ids of building asks whose PRs the last checks found all merged and whose ref names no step left; starts checks for the rest. */
    take(botId: string, threadId: string, asks: readonly TaskAsk[] | undefined): string[] {
      const merged = verdicts(botId, threadId, asks, true).filter((verdict) => verdict.merged && !stepLeft(verdict.ask.ref)).map(({ ask }) => ask);
      taken.set(threadId, new Map(merged.map((ask) => [ask.id, ask.changedAt])));
      return merged.map((ask) => ask.id);
    },
    /** Lines for building asks whose PRs all merged but whose ref names a step left; "" when unchanged since the last, unless full. No I/O. */
    stepNote(botId: string, threadId: string, asks: readonly TaskAsk[] | undefined, full = false): string {
      const kept = verdicts(botId, threadId, asks, false).filter((verdict) => verdict.merged && stepLeft(verdict.ask.ref));
      return once(told, threadId, kept.map(({ ask }) => closedAskLine(ask)).join("\n"), full);
    },
    /** Each PR the ask's ref names with when it merged, whatever the ask's status: undefined while one is unchecked, null once one is open, gone or failed. start begins the checks still owed. */
    merged(botId: string, threadId: string, ask: Pick<TaskAsk, "ref">, start = false): MergedPr[] | null | undefined {
      const dir = deps.repoDir(botId, threadId);
      const each = refPrs(ask.ref).map((pr) => ({ pr, last: placed(botId, dir, pr, start) }));
      if (!each.length || each.some(({ last }) => last && last.state !== "merged")) return null;
      if (each.some(({ last }) => !last)) return undefined;
      return each.map(({ pr, last }) => {
        const item: MergedPr = { ...pr };
        if (last?.mergedAt) item.mergedAt = last.mergedAt;
        return item;
      });
    },
    /** Building asks whose PRs could not be checked, and why. No I/O. */
    failed,
    /** One line naming every ask failed() holds; "" when that set has not changed since the last line, unless full. */
    failedNote(botId: string, threadId: string, asks: readonly TaskAsk[] | undefined, full = false): string {
      const rows = failed(botId, threadId, asks);
      const line = rows.length ? `[Wink could not tell if these asks' PRs merged, so they stay open: ${rows.map((row) => `${row.id} (${row.reason})`).join("; ")}.]` : "";
      return once(noted, threadId, line, full);
    },
    /** The asks this dispatched turn shows closed. */
    closing(threadId: string, turnId: string, ids: readonly string[]): void {
      pending.set(threadId, { turnId, changed: new Map(ids.map((id) => [id, taken.get(threadId)?.get(id)])) });
    },
    /** Ids to save as done once the turn that showed them ends; none unless it landed. With asks, only those still building and unchanged since take(). */
    landed(threadId: string, turnId: string, landed: boolean, asks?: readonly TaskAsk[]): string[] {
      const turn = pending.get(threadId);
      if (turn?.turnId !== turnId) return [];
      pending.delete(threadId);
      if (!landed) {
        noted.delete(threadId);
        told.delete(threadId);
        return [];
      }
      return [...turn.changed].filter(([id, at]) => !asks || asks.some((ask) => ask.id === id && ask.status === "building" && ask.changedAt === at)).map(([id]) => id);
    },
    /** Resolves once every check started so far has finished. */
    settled: () => Promise.all([...running.values()]).then(() => {}),
  };
}
