import type { SleepLine } from "./memory-clean-types.ts";
import { eligibleRow, secretLike, userTyping } from "./memory-pass.ts";
import type { Message } from "./store.ts";

const DAY = 86_400_000;
const MAX_BYTES = 24 * 1024;
const CONTEXT_CHARS = 300;
// a request opens the line or a clause; "i remember" or "if u remember" is not one
const REMEMBER = /(?:^|[.!?;:,]\s*|\b(?:please|pls|plz|also|btw|fyi|oh|ok|okay|so|but)\s+)(?:remember|don't forget|do not forget|keep in mind|make a note)\b|기억해|기억하세요|잊지\s*마|메모해/i;
// a question or "I don't remember" is not a request to remember
const ASKED = /\?\s*$|\b(?:i|you)\s+(?:don['’]t|do not|didn['’]t|can['’]t|cannot)\s+remember\b/i;
const CORRECTION = /^(no|nope|wrong|actually|not quite)\b|\b(that's wrong|that is wrong|that's not right|not what i|i said|i meant|correction|instead of)\b|아니야|아니요|아니라|틀렸|잘못|그게 아니/i;

/** The user's own lines since `through`, remember and correction lines first; a never-slept bot reads 7 days. */
export function sleepInput(messages: readonly Message[], through: number | null, now: number): { user: SleepLine[]; through: number } {
  const since = through ?? now - 7 * DAY;
  const lines: SleepLine[] = [];
  let newest = 0;
  messages.forEach((message, i) => {
    if (message.at <= since || !eligibleRow(message)) return;
    newest = Math.max(newest, message.at);
    for (const text of userTyping(message.text).split("\n").map((line) => line.trim()).filter(Boolean)) {
      if (secretLike(text)) continue;
      const kind = REMEMBER.test(text) && !ASKED.test(text) ? "remember" : CORRECTION.test(text) ? "correction" : "said";
      const reply = kind === "correction" ? messages.slice(0, i).findLast((row) => row.role === "bot" && row.kind === "text" && row.text?.trim())?.text : undefined;
      lines.push({ text, at: message.at, kind, ...(reply && !secretLike(reply) ? { context: reply.slice(0, CONTEXT_CHARS) } : {}) });
    }
  });
  let bytes = 0;
  const user = lines.sort((a, b) => Number(a.kind === "said") - Number(b.kind === "said") || b.at - a.at).filter((line) => {
    bytes += Buffer.byteLength(line.text) + Buffer.byteLength(line.context ?? "");
    return bytes <= MAX_BYTES;
  });
  return { user, through: newest || (through ?? now) };
}
