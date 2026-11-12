import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_PROMO_MESSAGE = "This OpenAI key's org is on API credit, which Codex can't use. Pick another Codex account.";
const CODE = "codex_byok_restricted_by_api_credit_promo";
const FILE = ".wink-codex-promo.json";

export function isCodexPromo(failure, depth = 0) {
  if (typeof failure === "string") return failure.includes(CODE);
  if (!failure || typeof failure !== "object" || depth > 3) return false;
  return ["message", "code", "type", "error", "additionalDetails"].some((key) => isCodexPromo(failure[key], depth + 1));
}

export function codexPromoBlocked(home, generation) {
  try {
    const mark = JSON.parse(readFileSync(join(home, FILE), "utf8"));
    return Number.isSafeInteger(mark?.generation) && (generation === undefined || mark.generation === generation);
  } catch { return false; }
}

function writeMark(home, mark) {
  mkdirSync(home, { recursive: true });
  const file = join(home, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(mark), { mode: 0o600 });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

export function markCodexPromo(home, generation) {
  writeMark(home, { generation });
}

export function clearCodexPromo(home) {
  if (existsSync(join(home, FILE))) writeMark(home, null);
}

export function requireCodexPromoAccount(home, generation) {
  if (codexPromoBlocked(home, generation)) throw new Error(CODEX_PROMO_MESSAGE);
}

export function codexPromoScreen(text, cols = 80) {
  const lines = [];
  let wrapped = false;
  for (const line of text.split("\n")) {
    if (wrapped) lines[lines.length - 1] += line.trimEnd();
    else lines.push(line.trimEnd());
    wrapped = line.length === cols;
  }
  const start = lines.findLastIndex((line) => /^\s*■\s+/.test(line));
  if (start < 0) return false;
  const tail = lines.slice(start);
  const end = tail.findIndex((line) => /^\s*›/.test(line));
  if (end >= 0 && tail.slice(end).some((line) => line.trim() && !/^\s*(?:›\s*$|\? for shortcuts|(?:gpt|GPT)-|\d+(?:\.\d+)?% context left|[─━]+\s*$)/.test(line))) return false;
  const block = tail.slice(0, end < 0 ? undefined : end);
  return !block.some((line) => /^\s*[●•]/.test(line)) && isCodexPromo(block.join(""));
}

export function watchCodexPromo(session, at, postNote) {
  if ((session.engine ?? session.workerEngine)?.toLowerCase() !== "codex" || !codexPromoScreen(session.screen.text(), session.cols)) return false;
  const env = session.workerEnvironment;
  const home = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex");
  const generation = session.workerAccount?.generation ?? session.workerSession?.run.accountGeneration ?? 0;
  const key = JSON.stringify([home, generation, session.stallArmedAt]);
  if (session.codexPromoNote?.key !== key) session.codexPromoNote = { key, at, retryAt: 0, marked: false };
  const note = session.codexPromoNote;
  if (at - note.at < 1000) return true;
  if (!note.marked) {
    try { markCodexPromo(home, generation); note.marked = true; }
    catch { console.error("Codex account restriction could not be saved"); }
  }
  if (session.mail && at >= note.retryAt) {
    postNote(session, note, CODEX_PROMO_MESSAGE, (delivered) => { note.retryAt = delivered ? Infinity : at + 15_000; });
  }
  return true;
}
