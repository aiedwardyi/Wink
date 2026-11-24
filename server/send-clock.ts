import { sendClock } from "../shared/send-clock.ts";

let sample: { at: number; since: number } | undefined;

function readServerClock() {
  const at = Date.now();
  const since = performance.now();
  const projected = sample ? Math.floor(sample.at + since - sample.since) : at;
  // Wall and elapsed readings can straddle a millisecond.
  if (projected <= at + 1) {
    sample = { at, since };
    return { at, cap: at };
  }
  // A send stamped from an earlier stream sample can still be in flight.
  return { at, cap: projected };
}

export function serverClockSample(): number {
  return readServerClock().at;
}

/** The cap a send's stamp is held to, read once where the send arrives: a wait for the chat after it must not move it. */
export function serverClockCap(): number {
  return readServerClock().cap;
}

export function serverSendClock(messages: Parameters<typeof sendClock>[0], cap = readServerClock().cap): number {
  return sendClock(messages, cap);
}
