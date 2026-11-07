import { EASE_STANDARD, MOTION_LARGE_MS } from "@/lib/motion";
import { reducedMemoryMotion } from "./MemoryCleanMotion";

export interface OpenParts {
  sheet: HTMLElement;
  content: HTMLElement[];
  mist: HTMLElement | null;
  specks: HTMLElement | null;
  /** the panel's width over the sheet's, where the sheet starts from */
  from: number;
  side: "left" | "right";
}

const SWING = "cubic-bezier(.16, 1, .3, 1)";
const origin = (side: OpenParts["side"]) => `${side} center`;

// 2A: the panel widens in place and its text fades in, under 300 ms
function light({ sheet, content, from, side }: OpenParts) {
  const inset = `${(1 - from) * 100}%`;
  sheet.animate([{ clipPath: side === "left" ? `inset(0 ${inset} 0 0 round 16px)` : `inset(0 0 0 ${inset} round 16px)` }, { clipPath: "inset(0 0 0 0 round 16px)" }], { duration: 260, easing: SWING });
  for (const el of content) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: 110, easing: "ease-out", fill: "backwards" });
}

// 2B: the panel swings inward in 3D, a purple mist brushes across with white specks, then the text
function full({ sheet, content, mist, specks, from, side }: OpenParts) {
  const sign = side === "left" ? 1 : -1;
  const width = sheet.offsetWidth;
  sheet.animate([
    { transform: `scaleX(${from}) rotateY(${sign * 70}deg)`, transformOrigin: origin(side), opacity: 0 },
    { offset: 0.35, opacity: 1 },
    { transform: "none", transformOrigin: origin(side), opacity: 1 },
  ], { duration: 460, easing: SWING });
  mist?.animate([
    { transform: `translateX(${sign * -0.7 * width}px)`, opacity: 0 },
    { offset: 0.35, opacity: 0.9 },
    { transform: `translateX(${sign * width}px)`, opacity: 0 },
  ], { duration: 700, delay: 60, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "backwards" });
  specks?.animate([
    { transform: `translateX(${sign * -60}px)`, opacity: 0 },
    { offset: 0.4, opacity: 1 },
    { transform: `translateX(${sign * 80}px)`, opacity: 0 },
  ], { duration: 760, delay: 100, easing: "ease-out", fill: "backwards" });
  for (const el of content) el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, delay: 380, easing: "ease-out", fill: "backwards" });
}

const MOTIONS = { light: { open: light, mist: false }, full: { open: full, mist: true } };
// the one switch between the two opens: MOTIONS.light is 2A
const MOTION = MOTIONS.full;

export const openMist = () => MOTION.mist && !reducedMemoryMotion();

export function openPanel(parts: OpenParts) {
  if (!reducedMemoryMotion()) MOTION.open(parts);
}

export function closePanel({ sheet, from, side }: OpenParts): Promise<unknown> {
  if (reducedMemoryMotion()) return Promise.resolve();
  for (const running of sheet.getAnimations({ subtree: true })) running.cancel();
  return sheet.animate([
    { transform: "none", transformOrigin: origin(side), opacity: 1 },
    { transform: `scaleX(${from})`, transformOrigin: origin(side), opacity: 0 },
  ], { duration: MOTION_LARGE_MS, easing: EASE_STANDARD, fill: "forwards" }).finished.catch(() => undefined);
}
