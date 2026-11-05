import type { Message } from "@/state/store";

export type TurnOrigin = { turnKey: string; originMs: number; source: "dispatch" | "row" | "observed" };
export type TurnOriginState = {
  origin?: TurnOrigin;
  dispatchKey?: string;
  providerTurnId?: string;
  rowId?: string;
  active: boolean;
};

type Event =
  | { type: "dispatch"; turnKey: string; dispatchKey: string; now: number }
  | { type: "started"; turnKey: string; now: number; row?: Message; retry?: boolean }
  | { type: "row"; row: Message; now: number }
  | { type: "history"; row?: Message }
  | { type: "hydrated"; turnKey: string; row?: Message; now: number }
  | { type: "completed" };

export function turnOriginRow(messages: readonly Message[]): Message | undefined {
  const users = messages.filter((row) => row.role === "user" && row.kind === "text" && !row.placeholder && !row.queued);
  return users.findLast((row) => !row.steered) ?? users[0];
}

function fromRow(turnKey: string, row: Message | undefined, now: number): TurnOrigin {
  const valid = row && Number.isFinite(row.at);
  const at = valid ? row.at : now;
  // A full reload cannot recover clock offset, so future rows start at first observation.
  return { turnKey, originMs: Math.min(at, now), source: valid && at <= now ? "row" : "observed" };
}

/** Dispatch and provider ids own the turn; transcript tail moves only attach its first row. */
export function nextTurnOrigin(prev: TurnOriginState, event: Event): TurnOriginState {
  switch (event.type) {
    case "dispatch":
      if (prev.dispatchKey === event.dispatchKey) return prev;
      return {
        active: true, dispatchKey: event.dispatchKey,
        origin: { turnKey: event.turnKey, originMs: event.now, source: "dispatch" },
      };
    case "started": {
      if (prev.providerTurnId === event.turnKey) return prev;
      if (prev.active && (!prev.providerTurnId || event.retry)) {
        return { ...prev, providerTurnId: event.turnKey };
      }
      return {
        active: true, providerTurnId: event.turnKey, rowId: event.row?.id,
        origin: fromRow(event.turnKey, event.row, event.now),
      };
    }
    case "row": {
      const row = event.row;
      if (row.role !== "user" || row.kind !== "text" || row.placeholder || row.queued || (prev.active && prev.rowId) || prev.rowId === row.id) return prev;
      if (!prev.active) return { active: true, rowId: row.id, origin: fromRow(row.id, row, event.now) };
      return {
        ...prev, active: true, rowId: row.id,
        origin: prev.origin && prev.origin.source !== "observed"
          ? prev.origin
          : fromRow(prev.origin?.turnKey ?? row.id, row, prev.origin?.originMs ?? event.now),
      };
    }
    case "history": {
      if (!prev.active || prev.origin?.source !== "observed" || !event.row || event.row.steered) return prev;
      const origin = fromRow(prev.origin.turnKey, event.row, prev.origin.originMs);
      if (origin.originMs === prev.origin.originMs && origin.source === prev.origin.source && prev.rowId === event.row.id) return prev;
      return { ...prev, rowId: event.row.id, origin };
    }
    case "hydrated":
      if (prev.active && (!event.row || !prev.rowId || prev.rowId === event.row.id)) return prev;
      return { active: true, rowId: event.row?.id, origin: fromRow(event.turnKey, event.row, event.now) };
    case "completed":
      return prev.active ? { ...prev, active: false } : prev;
  }
}

export function nextTurnOrigins(prev: Record<string, TurnOriginState>, action: { threadId: string; event: Event }): Record<string, TurnOriginState> {
  const current = prev[action.threadId] ?? { active: false };
  const next = nextTurnOrigin(current, action.event);
  return next === current ? prev : { ...prev, [action.threadId]: next };
}
