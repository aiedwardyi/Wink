/** A send is newer than the newest row on screen, whatever this device's clock says; the server caps a sent time by the same rule, so both agree. */
export function sendClock(messages: readonly { at: number }[] = [], now = Date.now()): number {
  return Math.max(now, (messages.at(-1)?.at ?? 0) + 1);
}
