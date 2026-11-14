export type MapCheckState = "pass" | "fail" | "pending" | "skip";

export interface MapCheck {
  name: string;
  state: MapCheckState;
}

export interface MapReview {
  login: string;
  state: "approved" | "changes" | "commented" | "dismissed" | "pending";
}

export interface MapPr {
  number: number;
  url: string;
  title: string;
  into: string;
  state: "open" | "draft" | "merged" | "closed";
  checks: MapCheck[];
  reviews: MapReview[];
  decision: "approved" | "changes" | "";
  threads: number | null;
  mergedAt?: number;
}

export interface MapCommit {
  sha: string;
  subject: string;
}

export interface MapFlow {
  branch: string;
  commits: MapCommit[];
  total: number;
  pushed: number;
  web?: string;
  pr: MapPr | null;
}

export type MapStageKey = "commit" | "push" | "pr" | "checks" | "review" | "merge";
export type MapTone = "ok" | "bad" | "run" | MapPr["state"];

export interface MapStage {
  key: MapStageKey;
  on: boolean;
  tone?: MapTone;
  url?: string;
  detail: string[];
  pass?: number;
  fail?: number;
  pending?: number;
  total?: number;
  who?: string[];
  threads?: number | null;
  at?: number;
}

export function mapFlowStages(flow: MapFlow): MapStage[] {
  const { pr, web } = flow;
  const last = flow.commits[0];
  // An unpushed commit has no page on GitHub yet.
  const commitUrl = !last ? undefined : flow.pushed < flow.total ? pr ? `${pr.url}/commits` : undefined : pr ? `${pr.url}/commits/${last.sha}` : web && `${web}/commit/${last.sha}`;
  const stages: MapStage[] = [{ key: "commit", on: flow.total > 0, url: commitUrl, detail: flow.commits.slice(0, 3).map(commit => `${commit.sha.slice(0, 7)} ${commit.subject}`) }];
  if (flow.pushed || pr) stages.push({ key: "push", on: flow.pushed > 0, tone: flow.pushed < flow.total ? "run" : undefined, url: web ? `${web}/tree/${encodeURI(flow.branch)}` : pr?.url, detail: [flow.branch] });
  if (!pr) return stages;
  const counted = pr.checks.filter(check => check.state !== "skip");
  const fail = counted.filter(check => check.state === "fail");
  const pending = counted.filter(check => check.state === "pending");
  const pass = counted.length - fail.length - pending.length;
  const changes = pr.decision === "changes" || pr.reviews.some(review => review.state === "changes");
  stages.push(
    { key: "pr", on: true, tone: pr.state, url: pr.url, detail: [pr.title, pr.into] },
    { key: "checks", on: fail.length > 0 || counted.length > 0 && !pending.length, tone: fail.length ? "bad" : pending.length ? "run" : counted.length ? "ok" : undefined, url: `${pr.url}/checks`,
      detail: (fail.length ? fail : pending).map(check => check.name), pass, fail: fail.length, pending: pending.length, total: counted.length },
    { key: "review", on: pr.reviews.length > 0, tone: changes ? "bad" : pr.decision === "approved" ? "ok" : pr.threads ? "run" : undefined, url: pr.url,
      detail: pr.reviews.map(review => `${review.login} ${review.state}`), who: pr.reviews.map(review => review.login), threads: pr.threads },
    { key: "merge", on: pr.state === "merged" || pr.state === "closed", tone: pr.state === "merged" || pr.state === "closed" ? pr.state : undefined, url: pr.url, detail: [pr.into], at: pr.mergedAt },
  );
  return stages;
}
