// A session's first AudioContext can block the main thread for up to a second, so a desktop hover makes it before the click.
import { isPhone } from "../phone-swipe";

const UNCLAIMED_MS = 10_000;

let warm: { ctx: AudioContext; timer: number } | undefined;

/** Phones skip it: their context has to be made in the tap to play. */
export function warmCallAudio() {
  if (isPhone() || typeof AudioContext === "undefined") return;
  if (warm) window.clearTimeout(warm.timer);
  const ctx = warm?.ctx ?? new AudioContext();
  const timer = window.setTimeout(() => {
    warm = undefined;
    void ctx.close();
  }, UNCLAIMED_MS);
  warm = { ctx, timer };
}

export function callAudio(): AudioContext {
  const held = warm;
  warm = undefined;
  if (!held) return new AudioContext();
  window.clearTimeout(held.timer);
  return held.ctx;
}
