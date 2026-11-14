import { execFile } from "node:child_process";
import { z } from "zod";
import type { MapCheck, MapFlow, MapPr, MapReview } from "../shared/map-flow.ts";
import { mapGit } from "./map-git.ts";

export type MapGh = (cwd: string, args: string[]) => Promise<string>;

const FIELDS = "number,state,isDraft,url,title,baseRefName,statusCheckRollup,reviews,reviewDecision,mergedAt";
const THREADS = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}";
const OPEN_FOR = 25_000;
const MISSING_FOR = 120_000;

const viewSchema = z.object({
  number: z.number(), state: z.enum(["OPEN", "MERGED", "CLOSED"]), isDraft: z.boolean().optional(), url: z.string().startsWith("https://"), title: z.string().optional(),
  baseRefName: z.string().optional(), reviewDecision: z.string().nullish(), mergedAt: z.string().nullish(),
  statusCheckRollup: z.array(z.object({ name: z.string().optional(), context: z.string().optional(), status: z.string().optional(), conclusion: z.string().nullish(), state: z.string().optional() })).nullish(),
  reviews: z.array(z.object({ author: z.object({ login: z.string() }).nullish(), state: z.string(), submittedAt: z.string().nullish() })).nullish(),
});
const threadsSchema = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({ reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })) }) }) }) }) });

const ghRun: MapGh = (cwd, args) => new Promise((done, fail) => {
  execFile("gh", args, {
    cwd, windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" },
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
  ]);
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

export function createMapFlow(gh: MapGh = ghRun) {
  const known = new Map<string, { key: string; at: number; pr: Promise<MapPr | null> }>();

  async function ask(root: string): Promise<MapPr | null> {
    try {
      const raw: unknown = JSON.parse(await gh(root, ["pr", "view", "--json", FIELDS]));
      const pr = mapPr(raw, null);
      const repo = pr && /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
      if (!pr || !repo) return pr;
      const threads = await gh(root, ["api", "graphql", "-f", `query=${THREADS}`, "-F", `owner=${repo[1]}`, "-F", `name=${repo[2]}`, "-F", `number=${pr.number}`])
        .then(text => threadsSchema.parse(JSON.parse(text)).data.repository.pullRequest.reviewThreads.nodes.filter(node => !node.isResolved).length).catch(() => null);
      return { ...pr, threads };
    } catch { return null; }
  }

  async function flow(root: string, base: string): Promise<MapFlow> {
    const { key, remote, ...git } = await gitFlow(root, base);
    if (!remote) return { ...git, pr: null };
    const now = Date.now();
    let entry = known.get(root);
    const settled = entry && await entry.pr;
    const fresh = entry?.key === key && (settled ? settled.state === "merged" || settled.state === "closed" || now - entry.at < OPEN_FOR : now - entry.at < MISSING_FOR);
    if (!entry || !fresh) known.set(root, entry = { key, at: now, pr: ask(root) });
    return { ...git, pr: await entry.pr };
  }

  return { flow };
}
