/**
 * Post-turn billing reads, at most one per account per minute. A turn that
 * skips the read never touches the pipe, so the next prompt cannot race it.
 */
export const BILLING_READ_EVERY_MS = 60_000;

export function billingThrottle() {
  let last: { account: string; at: number } | null = null;
  return {
    /** Claims the read when one is due; release() hands it back if the read fails. */
    take(account: string): { release(): void } | null {
      const at = Date.now();
      if (last && last.account === account && at - last.at < BILLING_READ_EVERY_MS) return null;
      const claim = (last = { account, at });
      return { release: () => { if (last === claim) last = null; } };
    },
  };
}
