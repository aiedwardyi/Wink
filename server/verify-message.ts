import { VERIFY_LIMITS, type VerifyCardData, type VerifyCardStatus, type VerifyChecker, type VerifyCounts, type VerifyErrorCode, type VerifyIssue, type VerifyResult, type VerifyTile } from "../shared/live-verify.ts";
import { redactSecretsInText } from "./redact.ts";

const STATUSES = new Set<VerifyCardStatus>(["offered", "waiting", "preparing", "running", "completed", "skipped", "blocked", "stale"]);
const CHECKERS = new Set<VerifyChecker>(["TEXT_A", "TEXT_B", "HEADINGS", "LINKS", "FONT", "CONTRAST", "BUTTONS", "NAV", "CLICK", "FORM", "FIT", "PAGE_ERRORS"]);
const TILES = new Set<VerifyTile>(["desktop", "phone"]);

export const VERIFY_REASONS: Record<VerifyErrorCode, string> = {
  "needs-approval": "it needs the user's OK and they are away",
  denied: "an approval policy refused it",
  "desktop-required": "it needs the Wink desktop app on Windows",
  "outside-folders": "the entry is not inside your working folder or workspace",
  "not-a-site": "it is not a static site (a folder with index.html, or an .html or .htm file)",
  busy: "another Live Verify run is going; try again when it finishes",
  "page-failed": "a page crashed or never loaded",
  timeout: "the run passed its time limit",
  cancelled: "the run was cancelled",
  "site-changed": "the site files changed during the check",
  "resource-limit": "the site is over the Live Verify size limits",
  "isolation-failed": "the page isolation check failed",
  internal: "an internal error; details are in the desktop log",
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const time = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown, max: number) => typeof value === "string" ? redactSecretsInText(value).slice(0, max) : null;

function counts(value: unknown): VerifyCounts | undefined {
  if (!record(value)) return undefined;
  const keys = ["planned", "completed", "passed", "failed", "blocked", "notRun"] as const;
  return keys.every((key) => count(value[key])) ? Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as VerifyCounts : undefined;
}

function issue(value: unknown): VerifyIssue | null {
  if (!record(value) || !CHECKERS.has(value.checker as VerifyChecker) || !TILES.has(value.tile as VerifyTile)) return null;
  const rule = text(value.rule, 80);
  const where = text(value.where, 120);
  const measured = text(value.measured, 160);
  if (rule === null || where === null || measured === null) return null;
  const out: VerifyIssue = { checker: value.checker as VerifyChecker, tile: value.tile as VerifyTile, rule, where, measured };
  if (typeof value.scrollY === "number" && Number.isFinite(value.scrollY)) out.scrollY = value.scrollY;
  if (Array.isArray(value.box) && value.box.length === 4 && value.box.every(n => typeof n === "number" && Number.isFinite(n)) && value.box[2] >= 0 && value.box[3] >= 0) out.box = value.box as VerifyIssue["box"];
  return out;
}

/** Stored and synced verify payloads are bot-adjacent text: cap every field and scrub site/rule/where/measured. */
export function redactVerifyCard(value: unknown): VerifyCardData | undefined {
  if (!record(value) || value.v !== 1 || !STATUSES.has(value.status as VerifyCardStatus) || (value.mode !== "ask" && value.mode !== "auto")) return undefined;
  if (typeof value.runId !== "string" || !/^[a-z0-9-]{8,64}$/.test(value.runId)) return undefined;
  if (typeof value.owner !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.owner)) return undefined;
  if (typeof value.decisionNonce !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.decisionNonce) || !time(value.offeredAt)) return undefined;
  const site = text(value.site, VERIFY_LIMITS.entryChars);
  if (site === null) return undefined;
  const out: VerifyCardData = { v: 1, runId: value.runId, owner: value.owner, site, status: value.status as VerifyCardStatus, mode: value.mode, decisionNonce: value.decisionNonce, offeredAt: value.offeredAt as number };
  if (typeof value.entry === "string") out.entry = text(value.entry, VERIFY_LIMITS.entryChars) ?? undefined;
  const tally = counts(value.counts);
  if (tally) out.counts = tally;
  if (Array.isArray(value.issues)) out.issues = value.issues.slice(0, VERIFY_LIMITS.issues).map(issue).filter((row): row is VerifyIssue => row !== null);
  if (Array.isArray(value.notChecked)) out.notChecked = value.notChecked.slice(0, 20).map(row => text(row, 200)).filter((row): row is string => row !== null);
  if (Array.isArray(value.details)) out.details = value.details.slice(0, VERIFY_LIMITS.issues).map(issue).filter((row): row is VerifyIssue => row !== null);
  if (count(value.issueTotal)) out.issueTotal = value.issueTotal as number;
  if (typeof value.errorCode === "string" && Object.hasOwn(VERIFY_REASONS, value.errorCode)) out.errorCode = value.errorCode as VerifyErrorCode;
  if (time(value.startedAt)) out.startedAt = value.startedAt as number;
  if (time(value.endedAt)) out.endedAt = value.endedAt as number;
  if (value.live === true) out.live = true;
  if (Array.isArray(value.replay)) out.replay = value.replay.filter((id): id is string => typeof id === "string" && /^[a-z0-9-]{8,64}$/.test(id)).slice(-3);
  return out;
}

const problemRules = new Set(["page error", "broken image", "missing target", "local 404", "self sign-up", "sideways scroll", "phone menu gone", "placeholder contact", "lorem", "TODO", "undefined", "NaN"]);

export const verifyProblems = (issues: VerifyIssue[]) => issues.filter(row => problemRules.has(row.rule));
const tokenCost = (text: string) => [...text].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 1 / 3 : 2), 0);
type ReplyDetail = { result?: VerifyResult | null; errorCode?: VerifyErrorCode; counts?: VerifyCounts | null };

export function verifyReplyText(status: VerifyCardStatus, _site: string, detail: ReplyDetail = {}): string {
  const { result } = detail;
  const code = detail.errorCode ?? result?.errorCode;
  if (status !== "completed" || !result || code) return `Not checked: ${VERIFY_REASONS[code ?? "internal"]}.`.slice(0, VERIFY_LIMITS.resultTextChars);
  const issues = verifyProblems(result.issues);
  const head = issues.length ? "Desktop and phone: problems found." : "Desktop and phone: no problems found.";
  const tail = issues.length ? "Fix these in this turn; call verify_site again, at most twice." : "";
  const unchecked = [...(result.notChecked ?? [])].sort((a, b) => Number(b === "form delivery") - Number(a === "form delivery")).map(row => `Not checked: ${row.slice(0, 80)}`);
  const lines = issues.map(row => `${row.tile === "phone" ? "Phone 392 px" : "Desktop 1280 px"}: ${row.rule} at ${row.where.slice(0, 70)}. ${row.measured.slice(0, 80)}. ${row.checker === "LINKS" ? "Click this link." : row.checker === "PAGE_ERRORS" ? "Reload the page." : "View this location."}`);
  const fits = (value: string) => value.length <= VERIFY_LIMITS.resultTextChars && tokenCost(value) <= 390;
  const format = (n: number, coverage: string) => [head, ...lines.slice(0, n), coverage, tail].filter(Boolean).join("\n");
  let coverage = unchecked.length ? `Not checked: ${unchecked.length} items` : "";
  for (let i = 1; i <= unchecked.length; i++) {
    const candidate = [...unchecked.slice(0, i), ...(i < unchecked.length ? [`and ${unchecked.length - i} more not checked`] : [])].join("\n");
    if (candidate.length > 360 || tokenCost(candidate) > 120 || !fits(format(1, candidate))) break;
    coverage = candidate;
  }
  let reply = format(1, coverage);
  for (let i = 2; i <= lines.length; i++) {
    const candidate = format(i, coverage);
    if (!fits(candidate)) break;
    reply = candidate;
  }
  return redactSecretsInText(reply);
}

/** The card's plain-text summary, for transcripts and model context. */
export function verifyCardText(card: VerifyCardData): string {
  if (card.status === "waiting") return "Waiting for another check.";
  if (card.status === "offered") return card.errorCode === "needs-approval"
    ? `Live Verify for ${card.site} is waiting for your OK.`
    : `Live Verify for ${card.site} is waiting for Watch or Skip.`;
  if (card.status === "preparing" || card.status === "running") return `Live Verify is checking ${card.site}.`;
  if (card.status === "stale") return `The Live Verify offer for ${card.site} expired. Nothing ran.`;
  const result: VerifyResult | null = card.status === "completed" && card.counts
    ? { v: 1, runId: card.runId, site: card.site, counts: card.counts, issues: card.issues ?? [], issueTotal: card.issueTotal ?? 0, notChecked: card.notChecked, durationMs: (card.endedAt ?? 0) - (card.startedAt ?? card.offeredAt) }
    : null;
  return verifyReplyText(card.status, card.site, { result, errorCode: card.errorCode, counts: card.counts }).split("\n")[0]!;
}
