// What the voice knows of the bot's state: the brief's STATUS at call start, and the same lines again as silent updates.
import { answersQuestion, scanQuestion } from "./open-question.ts";
import { parsePaneNote } from "./pane-note.ts";

export const STATUS_MAX_BYTES = 1_600;
const WORKERS_KEPT = 5;
const ORDER_CHARS = 300;
const QUESTION_CHARS = 300;
export const OPTION_CHARS = 80;
const REPORT = { done: "DONE", failed: "FAILED", blocked: "BLOCKED" } as const;

interface Row {
  id: string;
  role: string;
  kind: string;
  text?: string;
  from?: { botId?: string };
  author?: { kind: string };
  call?: { id: string; voice?: true; order?: true; ask?: true };
  card?: { title?: string; subtitle?: string; options?: string[]; tool?: string; askUser?: true; requestId?: string; answered?: string; dismissed?: boolean };
  secret?: { label: string; provided?: boolean; dismissed?: boolean; requestKey: string };
}

export const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const stop = (line: string) => /[.!?…]$/.test(line) ? line : `${line}.`;

/** UTF-8 safe byte cut on a whole line where one exists. */
export function capBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  const cut = new TextDecoder().decode(bytes.subarray(0, max)).replace(/�+$/, "");
  const lastBreak = cut.lastIndexOf("\n");
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

/** Newest reported state per worker, newest first; bodies stay out. */
export function workerReports(messages: readonly Row[]): string[] {
  const latest = new Map<string, string>();
  for (const row of messages) {
    if (row.kind !== "note" || !row.text) continue;
    const note = parsePaneNote(row.text);
    if (!note.status) continue;
    const name = note.nick ?? note.label?.split("|")[0]?.trim() ?? note.pane8 ?? "worker";
    latest.delete(name);
    latest.set(name, `${name} reported ${REPORT[note.status]}`);
  }
  return [...latest.values()].reverse().slice(0, WORKERS_KEPT);
}

/** The STATUS lines, capped in UTF-8 bytes; the clock rides separately so a change is a real change. */
export function callStatus(name: string, busy: boolean, messages: readonly Row[], queued = false, withQuestion = true): string {
  const order = busy ? messages.findLast((row) => answersQuestion(row) && row.text?.trim())?.text : undefined;
  const question = withQuestion ? scanQuestion(messages) : null;
  const options = question?.card?.options?.map((option) => clip(option, OPTION_CHARS)).join("; ");
  const workers = workerReports(messages);
  return capBytes([
    stop(`${name} is ${busy ? `busy${order ? `, working on: ${clip(order, ORDER_CHARS)}` : ""}` : "idle"}`),
    ...(queued ? ["Sends waiting to run after this."] : []),
    ...(question ? [`Open question for the person: ${clip(question.card?.subtitle || question.card?.title || "", QUESTION_CHARS)}${options ? ` Options: ${stop(options)}` : ""}`] : []),
    ...(workers.length ? [`Workers, newest first: ${workers.join("; ")}.`] : []),
  ].join("\n"), STATUS_MAX_BYTES);
}

/** The first approval or key card still open, as one line to say aloud. */
export function firstNeed(messages: readonly Row[]): { id: string; short: string } | undefined {
  for (const row of messages) {
    const card = row.card;
    if (row.kind === "options" && card?.requestId && !card.answered && !card.dismissed) {
      const head = card.title || card.tool || "a question";
      return { id: row.id, short: card.subtitle?.trim() ? `${head}: ${clip(card.subtitle, QUESTION_CHARS)}` : head };
    }
    const secret = row.secret;
    if (row.kind === "secret" && secret && !secret.provided && !secret.dismissed && !secret.requestKey.startsWith("call-")) return { id: row.id, short: secret.label };
  }
  return undefined;
}
