import type { Routine, RoutineManager, RoutineRun } from "./routines.ts";

export const WAKE_MAX_PENDING = 10;
export const WAKE_NOTE_MAX = 500;
export const WAKE_LATE_MS = 2 * 60_000;
const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

function localTime(at: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const stamp = new Date(at).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return `${stamp} (${zone})`;
}

export function pendingWakes(routines: RoutineManager, botId: string): Routine[] {
  return routines.listRoutines().filter((routine) => routine.wake && routine.botId === botId && routine.nextRunAt !== null);
}

export function setWake(
  routines: RoutineManager,
  input: { botId: string; threadId: string; at: unknown; note: unknown },
  now = Date.now(),
): { ok: true; id: string; at: number; local: string } | { ok: false; error: string } {
  const raw = typeof input.at === "string" ? input.at.trim() : "";
  const at = RFC3339_WITH_OFFSET.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) return { ok: false, error: "at must be an RFC3339 time with an offset, like 2026-11-14T03:45:00+09:00." };
  if (at - now < MIN_AHEAD_MS || at - now > MAX_AHEAD_MS) {
    return { ok: false, error: `at must be between 1 minute and 7 days from now (now is ${new Date(now).toISOString()}).` };
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!note) return { ok: false, error: "Give the wake a note: what to pick up when it rings." };
  if (note.length > WAKE_NOTE_MAX) return { ok: false, error: `Keep the note to ${WAKE_NOTE_MAX} characters.` };
  if (pendingWakes(routines, input.botId).length >= WAKE_MAX_PENDING) {
    return { ok: false, error: `You already have ${WAKE_MAX_PENDING} pending wakes. Cancel one first.` };
  }
  const routine = routines.create(
    { name: "Wake", prompt: note, botId: input.botId, schedule: { type: "once", at } },
    undefined,
    { threadId: input.threadId },
  );
  return { ok: true, id: routine.id, at, local: localTime(at) };
}

export function cancelWake(routines: RoutineManager, botId: string, id: string): boolean {
  return pendingWakes(routines, botId).some((routine) => routine.id === id) && routines.remove(id);
}

export function wakeFireLine(run: Pick<RoutineRun, "scheduledFor" | "late">, note: string, now: number): string {
  const late = run.late ? `, late: Wink was off then, it is now ${localTime(now)}` : "";
  return `[Wake] The wake you set for ${localTime(run.scheduledFor)} rang${late}. Your note: ${note}`;
}
