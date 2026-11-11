// The call card's data: the call's rows grouped in place, its length, and a voice stripe drawn from line times.
import { isVoiceLine } from "../../../shared/live-call";
import type { Message } from "@/state/store-types";

export const STRIPE_BARS = 48;
export type StripeBar = { who: "user" | "voice" | null; height: number };

const HANGUL = /[가-힣]/;

/** Each call's rows in order; `live` is the newest call while this device is still on it and it has no saved length. */
export function callRows(messages: Message[], onCall: boolean): { rows: Map<string, Message[]>; live?: string } {
  const rows = new Map<string, Message[]>();
  let last: string | undefined;
  for (const message of messages) {
    const id = message.call?.id;
    if (!id) continue;
    const list = rows.get(id);
    if (list) list.push(message);
    else rows.set(id, [message]);
    last = id;
  }
  return { rows, live: onCall && last && rows.get(last)![0]!.call!.ms === undefined ? last : undefined };
}

export function callLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Saved summary, else the person's first line, else the voice's. */
export function callSummary(rows: Message[]): string {
  const said = rows.filter((row) => isVoiceLine(row) && row.text?.trim());
  return rows[0]?.call?.summary ?? (said.find((row) => row.role === "user") ?? said[0])?.text?.trim() ?? "";
}

// No audio is kept: a line is guessed to take as long as its words, ending when it was saved.
function speakMs(text: string): number {
  return Math.min(20_000, Math.max(800, [...text].length * (HANGUL.test(text) ? 160 : 70)));
}

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

/** Who talked when across the call, as bar heights 0-1; silence is a low neutral bar. */
export function callStripe(rows: Message[], bars = STRIPE_BARS): StripeBar[] {
  const spans: Array<{ who: "user" | "voice"; start: number; end: number; seed: number }> = [];
  let until = -Infinity;
  for (const row of rows) {
    if (!isVoiceLine(row) || !row.text?.trim()) continue;
    const end = Math.max(until, row.at);
    spans.push({ who: row.role === "user" ? "user" : "voice", start: Math.max(until, row.at - speakMs(row.text)), end, seed: row.text.length });
    until = end;
  }
  if (!spans.length) return [];
  const from = spans[0]!.start;
  const step = Math.max(1, until - from) / bars;
  return Array.from({ length: bars }, (_, i) => {
    const at = from + (i + 0.5) * step;
    const span = spans.find((candidate) => at >= candidate.start && at <= candidate.end);
    return span ? { who: span.who, height: 0.35 + 0.65 * noise(span.seed * 31 + i) } : { who: null, height: 0.15 };
  });
}
