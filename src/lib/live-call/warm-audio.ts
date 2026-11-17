// A session's first AudioContext can block the main thread for up to a second, so a desktop hover makes it before the click.
import { isPhone } from "../phone-swipe";

const UNCLAIMED_MS = 10_000;

declare const tapped: unique symbol;
/** Only callAudio() makes one, in the call tap: a phone plays the voice later only if its element started there. */
export type CallSound = { readonly ctx: AudioContext; readonly voice: HTMLAudioElement; readonly [tapped]: true };

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

/** Call it in the tap itself, before any await. */
export function callAudio(): CallSound {
  const held = warm;
  warm = undefined;
  if (held) window.clearTimeout(held.timer);
  const ctx = held?.ctx ?? new AudioContext();
  void ctx.resume();
  const voice = new Audio();
  // Started empty, so its output still opens after the mic, on the call stream.
  voice.play().catch(() => {});
  return { ctx, voice } as CallSound;
}
