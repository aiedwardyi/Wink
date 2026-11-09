import { EASE_ENTRANCE, EASE_SOFT, EASE_STANDARD, MOTION_FAST_MS, MOTION_LARGE_MS } from "@/lib/motion";
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

const SWING = "cubic-bezier(.16, 1, .3, 1)";
const origin = (side: OpenParts["side"]) => `${side} center`;

// 2A: the panel widens in place and its text fades in, under 300 ms
function light({ sheet, content, from, side }: OpenParts) {
  const inset = `${(1 - from) * 100}%`;
  return [
    sheet.animate([{ clipPath: side === "left" ? `inset(0 ${inset} 0 0 round 16px)` : side === "right" ? `inset(0 0 0 ${inset} round 16px)` : `inset(${inset} 0 0 0 round 16px)` }, { clipPath: "inset(0 0 0 0 round 16px)" }], { duration: 260, easing: SWING }),
    ...content.map((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: 110, easing: "ease-out", fill: "backwards" })),
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
  ], { duration: 2 * MOTION_LARGE_MS, easing: EASE_SOFT });
  if (mist) loose.push(mist.animate([
    { transform: `translateX(${sign * -0.7 * width}px)`, opacity: 0 },
    { offset: 0.35, opacity: 0.9 },
    { transform: `translateX(${sign * width}px)`, opacity: 0 },
  ], { duration: 700, delay: 60, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "backwards" }));
  if (specks) loose.push(specks.animate([
    { transform: `translateX(${sign * -60}px)`, opacity: 0 },
    { offset: 0.4, opacity: 1 },
    { transform: `translateX(${sign * 80}px)`, opacity: 0 },
  ], { duration: 760, delay: 100, easing: "ease-out", fill: "backwards" }));
  return [swing, ...content.map((el) => el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: MOTION_LARGE_MS, delay: MOTION_LARGE_MS, easing: EASE_ENTRANCE, fill: "backwards" }))];
}

const MOTIONS = { light: { open: light, mist: false }, full: { open: full, mist: true } };
// the one switch between the two opens: MOTIONS.light is 2A
const MOTION = MOTIONS.full;
// the aura behind the badge: "a" breathes, "b" also drifts
export const AURA: "a" | "b" = "a";

let software: boolean | undefined;
/** True without a GPU, where the 2B swing drops frames: there the map opens the 2A way and the glow holds still. */
export function softwareRender() {
  if (software !== undefined) return software;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    software = !gl || /swiftshader|llvmpipe|basic render|software/i.test(name);
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
    sheet.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: MOTION_LARGE_MS, easing: EASE_ENTRANCE }),
    ...content.map((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST_MS, delay: 60, easing: "ease-out", fill: "backwards" })),
  ];
}

// a phone fold takes its height at once, so what sits below slides down from where it was
export function openFold(fold: HTMLElement, below: HTMLElement[], sweep: HTMLElement | null, loose: Animation[]) {
  if (reducedMemoryMotion()) return;
  const height = fold.offsetHeight;
  // a fold taller than the screen sends these off it at once, and its deferred rows' estimates would make them jump
  if (height < window.innerHeight) for (const el of below) loose.push(el.animate([{ transform: `translateY(${-height}px)` }, { transform: "none" }], { duration: MOTION_LARGE_MS, easing: EASE_STANDARD }));
  if (sweep) loose.push(sweep.animate([
    { transform: "translateX(-100%)", opacity: 0 },
    { offset: 0.3, opacity: 1 },
    { transform: "translateX(190%)", opacity: 0 },
  ], { duration: 420, delay: 30, easing: EASE_STANDARD, fill: "backwards" }));
}

// a close is the open played back from where it is, a whole one in MOTION_LARGE_MS; resolves false when turned around again
export function playOpen(anims: Animation[], forward: boolean): Promise<boolean> {
  if (!anims.length) return Promise.resolve(true);
  // a close under reduced motion lands at once; a reopen then just stays open
  if (reducedMemoryMotion()) {
    for (const each of anims) each.cancel();
    return Promise.resolve(!forward);
  }
  const end = Math.max(...anims.map((each) => Number(each.effect?.getComputedTiming().endTime ?? 0)));
  const rate = forward ? 1 : -end / MOTION_LARGE_MS;
  for (const each of anims) {
    each.effect?.updateTiming({ fill: "both" });
    // reverse(), not a set playbackRate and currentTime: those paint a composited sheet blank for a few frames
    each.updatePlaybackRate(-rate);
    each.reverse();
  }
  return Promise.all(anims.map((each) => each.finished)).then(() => anims.every((each) => each.playbackRate < 0), () => false);
}
