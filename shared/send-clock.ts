let server: { at: number; since: number } | undefined;

/** The server's clock off this window's live stream, counted on by elapsed time: a send stamped by it is one the server never caps, so the line never moves when the server answers. */
export function noteServerTime(at?: number): void {
  server = at === undefined ? undefined : { at, since: performance.now() };
}

function serverNow(clock: { at: number; since: number }): number {
  return Math.floor(clock.at + performance.now() - clock.since);
}

/** A send is newer than the newest row on screen, whatever this device's clock says; the server caps a sent time by the same rule, so both agree. */
export function sendClock(messages: readonly { at: number; actedAt?: number; waited?: boolean }[] = [], now = server ? serverNow(server) : Date.now()): number {
  const last = messages.at(-1);
  // a line stamped past a row ahead of this clock is ordered by that stamp, not by when it landed
  const newest = last && !last.waited ? Math.max(last.at, last.actedAt ?? 0) : last?.at ?? 0;
  return Math.max(now, newest + 1);
}
