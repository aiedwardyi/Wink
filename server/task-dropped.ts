import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";
import type { TaskAsk } from "./task-asks.ts";
import type { TaskResumePacket } from "./task-state.ts";

const DROPPED_DIR = join(DATA_DIR, "task-state-dropped");
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const lineSchema = z.object({ at: z.number() });

// the input and seen asks have not been through normalize, so the redactor has not seen their text yet
function redacted(ask: TaskAsk): TaskAsk {
  const copy = { ...ask, ask: redactSecretsInText(ask.ask) };
  if (ask.ref) copy.ref = redactSecretsInText(ask.ref);
  if (ask.choices) copy.choices = redactSecretsInText(ask.choices);
  return copy;
}

/** One line per ask `held` had and the saved packet lost, its newest copy by changedAt; `held` runs oldest first. A failed append is reported, never thrown, so the save stands. */
export function logDroppedAsks(saved: TaskResumePacket, ...held: (readonly TaskAsk[] | undefined)[]): void {
  try {
    const kept = new Set(saved.asks?.map((ask) => ask.id));
    const dropped = new Map<string, TaskAsk>();
    for (const ask of held.flatMap((asks) => asks ?? [])) {
      if (!kept.has(ask.id) && ask.changedAt >= (dropped.get(ask.id)?.changedAt ?? 0)) dropped.set(ask.id, ask);
    }
    if (!dropped.size) return;
    const at = Date.now();
    const lines = [...dropped.values()].map((ask) => `${JSON.stringify({ at, botId: saved.botId, threadId: saved.threadId, ask: redacted(ask) })}\n`);
    mkdirSync(DROPPED_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(join(DROPPED_DIR, `${saved.threadId}.jsonl`), lines.join(""), { mode: 0o600 });
  } catch (error) {
    console.error("task state: drop log failed", error);
  }
}

function fresh(line: string, now: number): boolean {
  try {
    const parsed = lineSchema.safeParse(JSON.parse(line));
    return parsed.success && now - parsed.data.at <= KEEP_MS;
  } catch {
    return false;
  }
}

export function sweepDroppedAsks(now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(DROPPED_DIR).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(DROPPED_DIR, name);
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const kept = lines.filter((line) => fresh(line, now));
      if (!kept.length) rmSync(path, { force: true });
      else if (kept.length < lines.length) writeFileAtomic(path, kept.map((line) => `${line}\n`).join(""), { mode: 0o600 });
    } catch (error) {
      console.error("task state: drop log sweep failed", error);
    }
  }
}
