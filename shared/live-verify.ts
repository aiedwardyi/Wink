export const LIVE_VERIFY_V0: boolean = true;

export const VERIFY_TOOL = "verify_site";
/** agents-proxy lists verify_site only when this env var is "1". */
export const VERIFY_TOOL_ENV = "OMB_LIVE_VERIFY";

export type VerifyTile = "desktop" | "phone";
export type VerifyChecker =
  | "TEXT_A" | "TEXT_B" | "HEADINGS" | "LINKS" | "FONT" | "CONTRAST"
  | "BUTTONS" | "NAV" | "CLICK" | "FORM" | "FIT" | "PAGE_ERRORS";

export type VerifyCardStatus =
  | "offered"    // Ask: waiting for Watch / Skip; nothing has loaded
  | "preparing"  // approved; pages loading, scan checks running
  | "waiting"
  | "running"    // show playing, live clicks and typing
  | "completed"  // result in, counts final
  | "skipped"    // the user tapped Skip on an Ask offer; nothing ran
  | "blocked"    // could not run or finish; see errorCode
  | "stale";     // the offer expired, or Wink restarted mid-run

export type VerifyErrorCode =
  | "needs-approval"    // Ask mode while the user is away: card held, nothing ran
  | "denied"            // an approval policy denied it
  | "desktop-required"  // no Wink desktop app to run pages in
  | "outside-folders"   // entry is not inside the bot's working folder or workspace
  | "not-a-site"        // no index.html in the folder, or not an .html file
  | "busy"              // another run is going (v0 runs one at a time)
  | "page-failed"       // a page crashed or never loaded
  | "timeout"           // the run passed VERIFY_LIMITS.runMs
  | "cancelled"         // the bot's turn stopped, or Wink is closing
  | "site-changed"
  | "resource-limit"
  | "isolation-failed"
  | "internal";         // runner bug; details in the desktop log

export interface VerifyCounts {
  planned: number;
  completed: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
}

export interface VerifyIssue {
  checker: VerifyChecker;
  tile: VerifyTile;
  /** The checker's name for what failed, e.g. "contrast", "tap target", "cut text". */
  rule: string;
  /** Plain-text locator: tag#id.class plus a short text snippet, at most 120 chars. */
  where: string;
  /** What was measured against what was needed, e.g. "3.1:1, needs 4.5:1". At most 160 chars. */
  measured: string;
  /** Page scroll (CSS px) the element was measured at. */
  scrollY?: number;
  /** CSS px in the viewport at scrollY. */
  box?: [number, number, number, number];
}

export interface VerifyResult {
  v: 1;
  runId: string;
  /** Display path of the entry, relative to the owned root it is in. */
  site: string;
  counts: VerifyCounts;
  /** Failed checks only, in checker order, at most VERIFY_LIMITS.issues. */
  issues: VerifyIssue[];
  /** All failed checks before the cap. */
  issueTotal: number;
  /** Set when the run ended early; counts are then honest partial counts. */
  errorCode?: VerifyErrorCode;
  durationMs: number;
  notChecked?: string[];
  details?: VerifyIssue[];
}

/** message.verify on a kind:"note" chat message: one current card per owner/thread, patched in place. */
export interface VerifyCardData {
  v: 1;
  runId: string;
  /** Bot id that called verify_site. */
  owner: string;
  site: string;
  entry?: string;
  status: VerifyCardStatus;
  mode: "ask" | "auto";
  decisionNonce: string;
  counts?: VerifyCounts;
  issues?: VerifyIssue[];
  issueTotal?: number;
  notChecked?: string[];
  details?: VerifyIssue[];
  errorCode?: VerifyErrorCode;
  /** epoch ms */
  offeredAt: number;
  startedAt?: number;
  endedAt?: number;
  live?: true;
  replay?: string[];
  /** problems an earlier run of this turn found that this run no longer finds */
  fixed?: number;
}

export const VERIFY_ACTIVE_STATUSES: readonly VerifyCardStatus[] = ["offered", "waiting", "preparing", "running"];

export const VERIFY_LIMITS = {
  /** Ask while attended: Watch / Skip stays open this long, then the card goes stale. */
  askWaitMs: 120_000,
  /** Ask while away: the held card goes stale after this. */
  heldMs: 30 * 60_000,
  /** Pages + scan checks + show + finalize, hard stop. */
  runMs: 60_000,
  /** Whole tool call; below the 300 s agents-MCP limit (server/drivers/codex.ts:147). */
  toolMs: 230_000,
  issues: 40,
  resultTextChars: 1_200,
  entryChars: 1_024,
  scanEntries: 2_000,
  scanMs: 250,
  autoFreeBytes: 2_656 * 1024 * 1024,
} as const;

export const VERIFY_ROUTES = {
  /** agents-proxy -> server. Comms Bearer. Body { entry }. Replies VerifyToolReply. */
  tool: "/api/internal/verify-site",
  /** UI -> server. App auth. Body { action, nonce }. 200 { status } | 404 { error: "not-here" }. */
  decision: "/api/verify/runs/:runId/decision",
  /** UI -> server. App auth. The run's chunk stream while it runs, then its replay file. */
  live: "/api/verify/runs/:runId/live",
  /** UI -> server. App auth. The replay file; 404 once pruned. */
  replay: "/api/verify/runs/:runId/replay",
} as const;

/** .lvr kind 0 */
export interface VerifyReplayHead {
  v: 1;
  runId: string;
  site: string;
  /** entry path relative to the site root */
  page: string;
  startedAt: number;
  tiles: Record<VerifyTile, [number, number]>;
}

/** .lvr kind 3 */
export interface VerifyReplayEnd {
  status: VerifyCardStatus;
  ms: number;
  issues: VerifyIssue[];
  notChecked: string[];
}

export type VerifyDecision = "watch" | "skip" | "rerun";

export interface VerifyToolReply {
  status: VerifyCardStatus;
  runId?: string;
  result?: VerifyResult;
  errorCode?: VerifyErrorCode;
  /** Exactly what the bot gets back as its tool result. */
  text: string;
}

/** A card the UI should show as stale: active, but older than its limit
 * (the server lost it on restart, or the offer timed out unseen). */
export function verifyCardStale(card: VerifyCardData, now: number): boolean {
  if (!VERIFY_ACTIVE_STATUSES.includes(card.status)) return false;
  const held = card.status === "offered" && card.errorCode === "needs-approval";
  const offered = card.status === "offered";
  const since = offered ? card.offeredAt : card.startedAt ?? card.offeredAt;
  const limit = held ? VERIFY_LIMITS.heldMs : offered ? VERIFY_LIMITS.askWaitMs : VERIFY_LIMITS.runMs + 10_000;
  return now - since >= limit;
}
