import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { MapCheck, MapFlow, MapPr, MapReview } from "../shared/map-flow.ts";
import { writeFileAtomic } from "./atomic.ts";
import { scrubbedEnv } from "./config.ts";
import { mapGit } from "./map-git.ts";

export type MapGh = (cwd: string, args: string[]) => Promise<string>;

const FIELDS = "number,state,isDraft,url,title,baseRefName,statusCheckRollup,reviews,reviewDecision,mergedAt";
const REVIEWS = "reviews(first:100,after:$after,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){pageInfo{hasNextPage endCursor} nodes{url submittedAt}}";
const THREADS = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}} ${REVIEWS}}}}`;
const MORE_REVIEWS = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${REVIEWS}}}}`;
const OPEN_FOR = 25_000;
const MISSING_FOR = 120_000;
const KEEP = 200;

const viewSchema = z.object({
  number: z.number(), state: z.enum(["OPEN", "MERGED", "CLOSED"]), isDraft: z.boolean().optional(), url: z.string().startsWith("https://"), title: z.string().optional(),
  baseRefName: z.string().optional(), reviewDecision: z.string().nullish(), mergedAt: z.string().nullish(),
  statusCheckRollup: z.array(z.object({ name: z.string().optional(), context: z.string().optional(), status: z.string().optional(), conclusion: z.string().nullish(), state: z.string().optional() })).nullish(),
  reviews: z.array(z.object({ author: z.object({ login: z.string() }).nullish(), state: z.string(), submittedAt: z.string().nullish() })).nullish(),
});
const reviewsSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  nodes: z.array(z.object({ url: z.string(), submittedAt: z.string().nullish() }).nullable()).nullish().transform(nodes => nodes?.filter(node => node !== null) ?? []),
});
const threadsSchema = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })) }), reviews: reviewsSchema.nullish() }) }) }) });
const lastSchema = z.record(z.string(), z.object({
  at: z.number(),
  flow: z.object({ branch: z.string(), commits: z.array(z.object({ sha: z.string(), subject: z.string() })), total: z.number(), pushed: z.number(), web: z.string().optional(), pr: z.object({ number: z.number(), url: z.string(), state: z.enum(["open", "draft", "merged", "closed"]) }).passthrough().nullable() }),
}));
const moreReviewsSchema = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ reviews: reviewsSchema }) }) }) });

const GH_AUTH_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

export const ghRun: MapGh = (cwd, args) => new Promise((done, fail) => {
  execFile("gh", args, {
    cwd, windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    env: scrubbedEnv({ ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" }, GH_AUTH_ENV),
  }, (error, stdout) => error ? fail(error) : done(stdout));
});

function checkState(check: { status?: string; conclusion?: string | null; state?: string }): MapCheck["state"] {
  const value = check.state ?? (check.status === "COMPLETED" ? check.conclusion ?? "" : "PENDING");
  if (value === "SUCCESS" || value === "NEUTRAL") return "pass";
  if (value === "SKIPPED") return "skip";
  if (value === "PENDING" || value === "EXPECTED" || value === "QUEUED" || value === "IN_PROGRESS") return "pending";
  return "fail";
}

const REVIEW: Record<string, MapReview["state"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented", DISMISSED: "dismissed" };

export function mapPr(raw: unknown, threads: number | null): MapPr | null {
  const parsed = viewSchema.safeParse(raw);
  if (!parsed.success) return null;
  const view = parsed.data;
  const reviews = new Map<string, MapReview["state"]>();
  for (const review of (view.reviews ?? []).toSorted((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))) {
    const state = REVIEW[review.state];
    const login = review.author?.login.replace(/\[bot\]$/, "");
    if (!state || !login) continue;
    const was = reviews.get(login);
    // A later comment does not undo an approval or a change request.
    if (state === "commented" && (was === "approved" || was === "changes")) continue;
    reviews.set(login, state);
  }
  const mergedAt = view.mergedAt ? Date.parse(view.mergedAt) : NaN;
  return {
    number: view.number, url: view.url, title: view.title ?? "", into: view.baseRefName ?? "",
    state: view.state === "MERGED" ? "merged" : view.state === "CLOSED" ? "closed" : view.isDraft ? "draft" : "open",
    checks: (view.statusCheckRollup ?? []).map(check => ({ name: check.name ?? check.context ?? "", state: checkState(check) })),
    reviews: [...reviews].map(([login, state]) => ({ login, state })),
    decision: view.reviewDecision === "APPROVED" ? "approved" : view.reviewDecision === "CHANGES_REQUESTED" ? "changes" : "",
    threads, ...Number.isFinite(mergedAt) && { mergedAt },
  };
}

function githubWeb(remote: string) {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

async function gitFlow(root: string, base: string) {
  const range = `${base}..HEAD`;
  const [branch, head, log, total, ahead] = await Promise.all([
    mapGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    mapGit(root, ["rev-parse", "HEAD"]),
    mapGit(root, ["log", "--no-color", "-n", "30", "--format=%H%x1f%s", range, "--"]),
    mapGit(root, ["rev-list", "--count", range, "--"]),
    mapGit(root, ["rev-list", "--count", "HEAD", "--not", base, "--remotes", "--"]),
  ]).catch(async error => {
    // A repo with no commits yet has no HEAD: its flow is empty, not broken.
    if (await mapGit(root, ["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false)) throw error;
    return [await mapGit(root, ["symbolic-ref", "--short", "HEAD"]), "", "", "0", "0"];
  });
  const name = branch.trim();
  const refs = name === "HEAD" ? "" : await mapGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)", `refs/remotes/*/${name}`]);
  const remotes = refs.split("\n").filter(Boolean).map(line => line.split("\0"));
  const remote = remotes.find(([, sha]) => sha === head.trim()) ?? remotes[0];
  const remoteName = remote?.[0].split("/")[2];
  const web = remoteName ? githubWeb(await mapGit(root, ["remote", "get-url", remoteName]).catch(() => "")) : undefined;
  const count = Number(total.trim()) || 0;
  return {
    branch: name, total: count, pushed: Math.max(0, count - (Number(ahead.trim()) || 0)), ...web && { web },
    commits: log.split("\n").filter(Boolean).map(line => { const [sha, subject] = line.split("\x1f"); return { sha, subject: subject ?? "" }; }),
    key: `${name}\0${head.trim()}\0${remote?.[1] ?? ""}`, remote: Boolean(remote),
  };
}

// A checkout's last rows belong to its folder, its .git (a repo made again there is another), the worker's base commit and the branch in HEAD, read with no git spawn.
async function lastKey(root: string, base: string) {
  const dot = join(root, ".git");
  const own = await stat(dot);
  const dir = own.isDirectory() ? dot : resolve(root, /^gitdir:\s*(.+)$/m.exec(await readFile(dot, "utf8"))?.[1].trim() ?? "");
  return `${resolve(root)}\0${own.ino}:${own.birthtimeMs}\0${base}\0${(await readFile(join(dir, "HEAD"), "utf8")).trim()}`;
}

export function createMapFlow(gh: MapGh = ghRun, file?: string) {
  const known = new Map<string, { key: string; at: number; pr: Promise<MapPr | null> }>();
  let saved: Promise<Map<string, { at: number; flow: MapFlow }>> | undefined;
  // SAFETY: the file holds only flows this module wrote, and the schema checks every field the rows read.
  const load = () => saved ??= (file ? readFile(file, "utf8").then(text => new Map(Object.entries(lastSchema.parse(JSON.parse(text)) as Record<string, { at: number; flow: MapFlow }>))) : Promise.reject(new Error("no file"))).catch(() => new Map());

  async function ask(root: string): Promise<MapPr | null> {
    try {
      const raw: unknown = JSON.parse(await gh(root, ["pr", "view", "--json", FIELDS]));
      const pr = mapPr(raw, null);
      const repo = pr && /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
      if (!pr || !repo) return pr;
      const graph = (query: string, after?: string) => gh(root, ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${repo[1]}`, "-F", `name=${repo[2]}`, "-F", `number=${pr.number}`, ...after ? ["-f", `after=${after}`] : []]);
      const extra = await graph(THREADS).then(text => threadsSchema.parse(JSON.parse(text)).data.repository.pullRequest).catch(() => null);
      // GitHub lists reviews by when they were started, so the one submitted last can sit on any page: a page that fails leaves the link on the PR.
      let reviews = extra?.reviews?.nodes ?? null;
      for (let page = extra?.reviews?.pageInfo; reviews && page?.hasNextPage;) {
        const next = page.endCursor ? await graph(MORE_REVIEWS, page.endCursor).then(text => moreReviewsSchema.parse(JSON.parse(text)).data.repository.pullRequest.reviews).catch(() => null) : null;
        reviews = next && [...reviews, ...next.nodes];
        page = next?.pageInfo;
      }
      const latest = reviews?.filter(node => node.url.startsWith(`${pr.url}#pullrequestreview-`)).toSorted((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "")).at(-1);
      return { ...pr, threads: extra ? extra.reviewThreads.nodes.filter(node => !node.isResolved).length : null, ...latest && { reviewUrl: latest.url } };
    } catch { return null; }
  }

  async function read(root: string, base: string): Promise<MapFlow> {
    const { key, remote, ...git } = await gitFlow(root, base);
    if (!remote) return { ...git, pr: null };
    const now = Date.now();
    let entry = known.get(root);
    const settled = entry && await entry.pr;
    const fresh = entry?.key === key && (settled ? settled.state === "merged" || settled.state === "closed" || now - entry.at < OPEN_FOR : now - entry.at < MISSING_FOR);
    if (!entry || !fresh) known.set(root, entry = { key, at: now, pr: ask(root) });
    return { ...git, pr: await entry.pr };
  }

  async function flow(root: string, base: string): Promise<MapFlow> {
    const key = await lastKey(root, base).catch(() => null);
    const result = await read(root, base);
    // A branch switched mid-read would file these rows under the wrong branch.
    if (!key || key !== await lastKey(root, base).catch(() => null)) return result;
    const flows = await load();
    flows.delete(key);
    flows.set(key, { at: Date.now(), flow: result });
    for (const old of [...flows.keys()].slice(0, Math.max(0, flows.size - KEEP))) flows.delete(old);
    if (file) try { mkdirSync(dirname(file), { recursive: true }); writeFileAtomic(file, JSON.stringify(Object.fromEntries(flows))); } catch { /* the rows still show; only the next open waits */ }
    return result;
  }

  async function last(root: string, base: string): Promise<MapFlow | null> {
    const key = await lastKey(root, base).catch(() => null);
    return key ? (await load()).get(key)?.flow ?? null : null;
  }

  return { flow, last };
}
