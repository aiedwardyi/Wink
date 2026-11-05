import { VERIFY_LIMITS, type VerifyCardData, type VerifyCardStatus, type VerifyChecker, type VerifyCounts, type VerifyErrorCode, type VerifyIssue, type VerifyResult, type VerifyTile } from "../shared/live-verify.ts";
import { redactSecretsInText } from "./redact.ts";

const STATUSES = new Set<VerifyCardStatus>(["offered", "preparing", "running", "completed", "skipped", "blocked", "stale"]);
const CHECKERS = new Set<VerifyChecker>(["TEXT_A", "TEXT_B", "HEADINGS", "LINKS", "FONT", "CONTRAST", "BUTTONS", "NAV", "CLICK", "FORM", "FIT"]);
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
  const tally = counts(value.counts);
  if (tally) out.counts = tally;
  if (Array.isArray(value.issues)) out.issues = value.issues.slice(0, VERIFY_LIMITS.issues).map(issue).filter((row): row is VerifyIssue => row !== null);
  if (count(value.issueTotal)) out.issueTotal = value.issueTotal as number;
  if (typeof value.errorCode === "string" && Object.hasOwn(VERIFY_REASONS, value.errorCode)) out.errorCode = value.errorCode as VerifyErrorCode;
  if (time(value.startedAt)) out.startedAt = value.startedAt as number;
  if (time(value.endedAt)) out.endedAt = value.endedAt as number;
  return out;
}

const countsLine = (c: VerifyCounts) => `${c.completed} checks, ${c.passed} passed, ${c.failed} issues, ${c.blocked} blocked, ${c.notRun} not run`;

type ReplyDetail = { result?: VerifyResult | null; errorCode?: VerifyErrorCode; counts?: VerifyCounts | null };

/** Exactly what the bot gets back. Issue lines are trimmed first to stay under the reply cap. */
export function verifyReplyText(status: VerifyCardStatus, site: string, detail: ReplyDetail = {}): string {
  const { result } = detail;
  const code = detail.errorCode ?? result?.errorCode;
  if (status === "skipped") return `The user skipped Live Verify for ${site}. Nothing ran.`;
  if (status === "stale") return `No answer on the Live Verify card for ${site} within 2 minutes. Nothing ran.`;
  if (code === "needs-approval") return `Live Verify for ${site} needs the user's OK and they are away. A card is waiting in the chat; nothing ran.`;
  if (status !== "completed" || !result || code) {
    const tally = result?.counts ?? detail.counts;
    const partial = tally && tally.completed > 0 ? `\nPartial: ${countsLine(tally)}.` : "";
    return `Live Verify could not finish ${site}: ${VERIFY_REASONS[code ?? "internal"]}.${partial}`.slice(0, VERIFY_LIMITS.resultTextChars);
  }
  const head = `Live Verify: ${site} - ${countsLine(result.counts)} (${Math.round(result.durationMs / 1000)} s).`;
  if (!result.issues.length) return `${head}\nNo issues found.`.slice(0, VERIFY_LIMITS.resultTextChars);
  const tail = "Fix them in the site files, then call verify_site again for a fresh full run.";
  const lines = result.issues.map((row, i) => `${i + 1}. ${row.checker} ${row.tile} · ${row.where} · ${row.measured}`);
  for (let shown = lines.length; shown >= 0; shown--) {
    const reply = [head, `Issues (${shown} of ${result.issueTotal}):`, ...lines.slice(0, shown), tail].join("\n");
    if (reply.length <= VERIFY_LIMITS.resultTextChars) return reply;
  }
  return head.slice(0, VERIFY_LIMITS.resultTextChars);
}

/** The card's plain-text summary, for transcripts and model context. */
export function verifyCardText(card: VerifyCardData): string {
  if (card.status === "offered") return card.errorCode === "needs-approval"
    ? `Live Verify for ${card.site} is waiting for your OK.`
    : `Live Verify for ${card.site} is waiting for Watch or Skip.`;
  if (card.status === "preparing" || card.status === "running") return `Live Verify is checking ${card.site}.`;
  if (card.status === "stale") return `The Live Verify offer for ${card.site} expired. Nothing ran.`;
  const result: VerifyResult | null = card.status === "completed" && card.counts
    ? { v: 1, runId: card.runId, site: card.site, counts: card.counts, issues: card.issues ?? [], issueTotal: card.issueTotal ?? 0, durationMs: (card.endedAt ?? 0) - (card.startedAt ?? card.offeredAt) }
    : null;
  return verifyReplyText(card.status, card.site, { result, errorCode: card.errorCode, counts: card.counts }).split("\n")[0]!;
}
