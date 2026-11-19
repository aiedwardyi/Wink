/** A send is newer than the newest row on screen, whatever this device's clock says; the server caps a sent time by the same rule, so both agree. */
export function sendClock(messages: readonly { at: number; actedAt?: number; waited?: boolean }[] = [], now = Date.now()): number {
  const last = messages.at(-1);
  // a line stamped past a row ahead of this clock is ordered by that stamp, not by when it landed
  const newest = last && !last.waited ? Math.max(last.at, last.actedAt ?? 0) : last?.at ?? 0;
  return Math.max(now, newest + 1);
}
