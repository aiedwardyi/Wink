export function createActionClock(wall = Date.now, monotonic = () => performance.now()) {
  let anchor: { server: number; local: number; roundTrip: number } | undefined;
  return {
    sample(server: number, started: number, received: number) {
      const roundTrip = received - started;
      if (!Number.isFinite(server) || !Number.isFinite(roundTrip) || server < 0 || roundTrip < 0) return;
      const expected = anchor ? anchor.server + received - anchor.local : 0;
      if (anchor && roundTrip >= anchor.roundTrip && server <= expected + roundTrip) return;
      anchor = { server: server + roundTrip / 2, local: received, roundTrip };
    },
    now() {
      return anchor ? Math.round(anchor.server + monotonic() - anchor.local) : wall();
    },
  };
}

export const actionClock = createActionClock(() => Date.now());
export const actionTime = () => actionClock.now();
