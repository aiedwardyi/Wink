// ask_bot's open slots, keyed by the asking thread and the ask's task id.
//
// MAX_COMMS_DEPTH stops recursion but not breadth: every peer a bot asks
// runs a full turn on its own model with a four-minute ceiling, and under a
// room's "everyone" policy each member can ask every other while they sit
// idle. The root budget caps the total; this caps how many wait at once,
// as create_bot and delegate_bot cap theirs at four.

export const MAX_OPEN_ASKS = 4;

const openAsks = new Map<string, Set<string>>();

/** Hold a slot from before approval until the ask's terminal result. */
export function claimOpenAsk(sourceThreadId: string, opId: string): boolean {
  const open = openAsks.get(sourceThreadId) ?? new Set<string>();
  if (!open.has(opId) && open.size >= MAX_OPEN_ASKS) return false;
  open.add(opId);
  openAsks.set(sourceThreadId, open);
  return true;
}

export function releaseOpenAsk(sourceThreadId: string, opId: string): void {
  const open = openAsks.get(sourceThreadId);
  if (!open?.delete(opId) || open.size) return;
  openAsks.delete(sourceThreadId);
}
