import { reducedMotion } from "./phone-swipe";
import { LIGHT_SKIN_IDS, readSkin } from "./skins";

/** One ripple per gap however fast the pointer moves, and a square mid-glint sits the next one out. */
export const RIPPLE_GAP_MS = 120;
const REACH = 7;
const STEP_MS = 36;
const SCATTER_MS = 70;
const GLINT_MS = 420;
const WEEKS = 26;
const CORNER = 2;
/** A glint's light over its life: up fast, a dip, a second catch, out. */
const GLOW: [offset: number, light: number][] = [[0, 0], [0.2, 1], [0.5, 0.3], [0.66, 0.65], [1, 0]];

type Glint = { box: [x: number, y: number, width: number, height: number]; from: number; peak: number; color: string };
type Sheet = { rippled: number; frame: number; glints: Map<number, Glint> };
const sheets = new WeakMap<HTMLCanvasElement, Sheet>();

function draw(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, sheet: Sheet, now: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!canvas.isConnected) sheet.glints.clear();
  for (const [day, { box, from, peak, color }] of sheet.glints) {
    const at = (now - from) / GLINT_MS;
    if (at >= 1) sheet.glints.delete(day);
    if (at <= 0 || at >= 1) continue;
    const next = GLOW.findIndex(([offset]) => offset > at);
    const [start, low] = GLOW[next - 1]!;
    const [end, high] = GLOW[next]!;
    ctx.globalAlpha = peak * (low + ((high - low) * (at - start)) / (end - start));
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(...box, CORNER * devicePixelRatio);
    ctx.fill();
  }
  sheet.frame = sheet.glints.size ? requestAnimationFrame((time) => draw(canvas, ctx, sheet, time)) : 0;
}

/** Glints spread from the square at `origin` on one canvas over the grid: a layer per square halves the frame rate at 4x. */
export function ripple(canvas: HTMLCanvasElement, origin: number, days: number, pale: (day: number) => boolean, now = performance.now()): void {
  const sheet = sheets.get(canvas) ?? { rippled: -Infinity, frame: 0, glints: new Map<number, Glint>() };
  if (now - sheet.rippled < RIPPLE_GAP_MS || reducedMotion()) return;
  const ctx = canvas.getContext("2d");
  const grid = canvas.parentElement;
  if (!ctx || !grid) return;
  sheets.set(canvas, sheet);
  sheet.rippled = now;
  const scale = devicePixelRatio;
  const edge = (at: number) => Math.round(at * scale);
  const box = grid.getBoundingClientRect();
  const style = getComputedStyle(grid);
  const gapX = parseFloat(style.columnGap) || 0;
  const gapY = parseFloat(style.rowGap) || 0;
  const side = (box.width - (WEEKS - 1) * gapX) / WEEKS;
  const width = edge(box.right) - edge(box.left);
  const height = edge(box.bottom) - edge(box.top);
  if (canvas.width !== width || canvas.height !== height) {
    Object.assign(canvas, { width, height });
    Object.assign(canvas.style, { width: `${width / scale}px`, height: `${height / scale}px` });
  }
  const accent = style.getPropertyValue("--color-accent").trim();
  ctx.fillStyle = accent;
  const hex = String(ctx.fillStyle);
  const sheen = `rgb(${[1, 3, 5].map((at) => Math.round(parseInt(hex.slice(at, at + 2), 16) * 0.35 + 255 * 0.65))})`;
  const light = LIGHT_SKIN_IDS.has(readSkin());
  for (let day = 0; day < days; day++) {
    const week = Math.floor(day / 7);
    const far = Math.hypot(week - Math.floor(origin / 7), (day % 7) - (origin % 7)) / REACH;
    if (far > 1 || sheet.glints.has(day) || Math.random() >= 1 - 0.6 * far * far) continue;
    const x = box.left + week * (side + gapX);
    const y = box.top + (day % 7) * (side + gapY);
    sheet.glints.set(day, {
      box: [edge(x) - edge(box.left), edge(y) - edge(box.top), edge(x + side) - edge(x), edge(y + side) - edge(y)],
      from: now + far * REACH * STEP_MS + Math.random() * SCATTER_MS,
      peak: (1 - 0.5 * far) * (0.55 + 0.45 * Math.random()),
      // A highlight vanishes into a light card, so pale squares deepen there instead.
      color: light && pale(day) ? accent : sheen,
    });
  }
  sheet.frame ||= requestAnimationFrame((time) => draw(canvas, ctx, sheet, time));
}
