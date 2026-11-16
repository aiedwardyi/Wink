// The usage_status tool: the Usage page's board as text a bot can read.
import type { UsageBoard, UsageBoardAccount, UsageBoardWindow } from "../src/lib/usage-board.ts";

const ENGINES = { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", muse: "Muse" } as const;
const MIN = 60_000;

const left = (window: UsageBoardWindow) => Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));

function label(window: UsageBoardWindow) {
  if (window.kind === "session") return "5h";
  if (window.kind === "week") return "7d";
  if (window.windowMinutes === null) return window.id;
  return window.windowMinutes >= 2880 && window.windowMinutes % 1440 === 0 ? `${window.windowMinutes / 1440}d` : `${Math.round(window.windowMinutes / 60)}h`;
}

function span(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / MIN));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function windowText(window: UsageBoardWindow, now: number, clock: Intl.DateTimeFormat) {
  const head = `${label(window)} ${left(window)}% left`;
  if (window.resetsAt === null) return `${head}, reset time unknown`;
  if (window.resetsAt <= now) return `${head}, reset passed (awaiting a fresh report)`;
  return `${head}, resets ${clock.format(window.resetsAt)} (in ${span(window.resetsAt - now)})`;
}

function unavailable(account: UsageBoardAccount) {
  if (account.codexPromo) return "unavailable: API credit promo";
  if (account.signIn === "signed-out") return "unavailable: signed out";
  if (account.signIn === "signing-in") return "unavailable: signing in";
  if (account.signIn === "draining") return "unavailable: signing out";
  return null;
}

function accountLine(account: UsageBoardAccount, now: number, clock: Intl.DateTimeFormat) {
  const name = `${account.name}${account.main ? " (Main)" : ""}`;
  const off = unavailable(account);
  if (off) return `- ${name}: ${off}`;
  if (account.credit) return `- ${name}: API credit, no plan limits`;
  if (!account.windows.length) return `- ${name}: no usage report yet`;
  const reached = account.windows.some((window) => window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > now));
  const age = account.observedAt === null ? "" : `; reported ${span(now - account.observedAt)} ago`;
  return `- ${name}: ${reached ? "Limit reached; " : ""}${account.windows.map((window) => windowText(window, now, clock)).join("; ")}${age}`;
}

export function usageStatusText(board: UsageBoard, timeZone: string) {
  const clock = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (!board.engines.length) return "No engine accounts on the Usage page yet.";
  const engines = board.engines.map((engine) =>
    [`${ENGINES[engine.engine] ?? engine.engine}:`, ...engine.accounts.map((account) => accountLine(account, board.at, clock))].join("\n"));
  return [`Usage page now (${clock.format(board.at)}, ${timeZone}). Percent is what is LEFT.`, ...engines,
    "Of the accounts with usage left, spend first the one whose window resets first."].join("\n");
}
