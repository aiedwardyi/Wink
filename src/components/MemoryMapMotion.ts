import { EASE_STANDARD, MOTION_FAST_MS, MOTION_LARGE_MS, MOTION_MODERATE_MS } from "@/lib/motion";
import { MIST_DELAY_MS, MIST_EASE, MIST_MS, SPECKS_DELAY_MS, SPECKS_EASE, SPECKS_MS, SWING_EASE, SWING_MS } from "@/lib/motion-character";
import { reducedMemoryMotion } from "./MemoryCleanMotion";

export interface OpenParts {
  sheet: HTMLElement;
  content: HTMLElement[];
  mist: HTMLElement | null;
  specks: HTMLElement | null;
  /** the panel's width (height from the bottom) over the sheet's, where the sheet starts from */
  from: number;
  side: "left" | "right" | "bottom";
}

const origin = (side: OpenParts["side"]) => `${side} center`;

// 2A: the panel slides out from its side and its text fades in
function light({ sheet, content, side }: OpenParts) {
  const at = side === "bottom" ? "translateY(8px)" : `translateX(${side === "right" ? 8 : -8}px)`;
  return [
    sheet.animate([{ opacity: 0, transform: at }, { opacity: 1, transform: "none" }], { duration: MOTION_LARGE_MS, easing: EASE_STANDARD }),
    ...content.map((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MODERATE_MS, delay: MOTION_LARGE_MS - MOTION_MODERATE_MS, easing: EASE_STANDARD, fill: "backwards" })),
  ];
}

// 2B: the panel swings inward in 3D, a purple mist brushes across with white specks, then the text
function full({ sheet, content, mist, specks, from, side }: OpenParts, loose: Animation[]) {
  const sign = side === "right" ? -1 : 1;
  const width = sheet.offsetWidth;
  const swing = sheet.animate([
    { transform: side === "bottom" ? `scaleY(${from}) rotateX(70deg)` : `scaleX(${from}) rotateY(${sign * 70}deg)`, transformOrigin: origin(side), opacity: 0 },
    { offset: 0.35, opacity: 1 },
    { transform: "none", transformOrigin: origin(side), opacity: 1 },
  ], { duration: SWING_MS, easing: SWING_EASE });
  if (mist) loose.push(mist.animate([
    { transform: `translateX(${sign * -0.7 * width}px)`, opacity: 0 },
    { offset: 0.35, opacity: 0.9 },
    { transform: `translateX(${sign * width}px)`, opacity: 0 },
  ], { duration: MIST_MS, delay: MIST_DELAY_MS, easing: MIST_EASE, fill: "backwards" }));
  if (specks) loose.push(specks.animate([
    { transform: `translateX(${sign * -60}px)`, opacity: 0 },
    { offset: 0.4, opacity: 1 },
    { transform: `translateX(${sign * 80}px)`, opacity: 0 },
  ], { duration: SPECKS_MS, delay: SPECKS_DELAY_MS, easing: SPECKS_EASE, fill: "backwards" }));
  return [swing, ...content.map((el) => el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: MOTION_LARGE_MS, delay: MOTION_LARGE_MS, easing: EASE_STANDARD, fill: "backwards" }))];
}

const MOTIONS = { light: { open: light, mist: false }, full: { open: full, mist: true } };
// the one switch between the two opens: MOTIONS.light is 2A
const MOTION = MOTIONS.full;
// the aura behind the badge: "a" breathes, "b" also drifts
export const AURA: "a" | "b" = "a";

let software: boolean | undefined;
const SOFTWARE = /swiftshader|llvmpipe|basic render|software/i;
/** True without a GPU, where the 2B swing drops frames: there the map opens the 2A way and the glow holds still. Given a renderer's name read elsewhere, it makes no context of its own. */
export function softwareRender(named?: string) {
  if (software !== undefined) return software;
  if (named !== undefined) return (software = SOFTWARE.test(named));
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    software = !gl || SOFTWARE.test(name);
  } catch {
    software = true;
  }
  return software;
}
const motion = () => (softwareRender() ? MOTIONS.light : MOTION);

export const openMist = () => motion().mist && !reducedMemoryMotion();

/** The swing and text come back to be played in reverse; the one-way mist and specks go into `loose`. */
export function openPanel(parts: OpenParts, loose: Animation[]): Animation[] {
  return reducedMemoryMotion() ? [] : motion().open(parts, loose);
}

// a sheet that takes over from another one, or from the editor, has nothing to swing out of
export function fadePanel({ sheet, content }: Pick<OpenParts, "sheet" | "content">): Animation[] {
  if (reducedMemoryMotion()) return [];
  return [
    sheet.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: MOTION_LARGE_MS, easing: EASE_STANDARD }),
    ...content.map((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MODERATE_MS, easing: EASE_STANDARD, fill: "backwards" })),
  ];
}

// a phone fold takes its height at once, so what sits below slides down from where it was
export function openFold(fold: HTMLElement, below: HTMLElement[], sweep: HTMLElement | null, loose: Animation[]) {
  if (reducedMemoryMotion()) return;
  const height = fold.offsetHeight;
  // a fold taller than the screen sends these off it at once, and its deferred rows' estimates would make them jump
  if (height < window.innerHeight) for (const el of below) loose.push(el.animate([{ transform: `translateY(${-height}px)` }, { transform: "none" }], { duration: MOTION_MODERATE_MS, easing: EASE_STANDARD }));
  if (sweep) loose.push(sweep.animate([
    { transform: "translateX(-100%)", opacity: 0 },
    { offset: 0.3, opacity: 1 },
    { transform: "translateX(190%)", opacity: 0 },
  ], { duration: MOTION_MODERATE_MS, easing: EASE_STANDARD }));
}

// a close is the open played back from where it is, a whole one in MOTION_FAST_MS; resolves false when turned around again
export function playOpen(anims: Animation[], forward: boolean): Promise<boolean> {
  if (!anims.length) return Promise.resolve(true);
  // a close under reduced motion lands at once; a reopen then just stays open
  if (reducedMemoryMotion()) {
    for (const each of anims) each.cancel();
    return Promise.resolve(!forward);
  }
  const end = Math.max(...anims.map((each) => Number(each.effect?.getComputedTiming().endTime ?? 0)));
  const rate = forward ? 1 : -end / MOTION_FAST_MS;
  for (const each of anims) {
    each.effect?.updateTiming({ fill: "both" });
    // reverse(), not a set playbackRate and currentTime: those paint a composited sheet blank for a few frames
    each.updatePlaybackRate(-rate);
    each.reverse();
  }
  return Promise.all(anims.map((each) => each.finished)).then(() => anims.every((each) => each.playbackRate < 0), () => false);
}
