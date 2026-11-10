import { color, shadows, type Source } from "./MemoryMapGlowPaint";
import { softwareRender } from "./MemoryMapMotion";

interface Painted { key: string; glow: HTMLElement[]; rings: HTMLCanvasElement[]; live: HTMLCanvasElement | null }
interface Reply { renderer?: string; layers: ImageBitmap[] | null }

// busy is shared on purpose: one worker, so one WebGL context, at a time
let unsupported = false, busy = false;
// the canvases of the last map to leave, for the next one to open
let painted: Painted | undefined;

/** False once a paint has failed here, so the map keeps its CSS glow. */
export const paintsGlow = () => !unsupported && typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined";

// the shader builds and paints off the main thread; null when this browser cannot paint it
function paint(source: Source) {
  return new Promise<ImageBitmap[] | null>((done) => {
    const worker = new Worker(new URL("./MemoryMapGlow.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<Reply>) => done(data.renderer !== undefined && softwareRender(data.renderer) ? null : data.layers);
    worker.onerror = () => { worker.terminate(); done(null); };
    worker.postMessage(source);
  });
}

// the layers arrive in the painter's order: dim map, open lift, breath, both, each ring, the Live card
function hang(layers: ImageBitmap[], source: Source, key: string, into: Painted | undefined): Painted | null {
  const out: Painted = into ?? { key, glow: [], rings: [], live: null };
  if (!into) {
    const [base, lift, breath, both] = ["", "mm-smooth-lift", "", "mm-smooth-lift"].map((name) => Object.assign(document.createElement("canvas"), { className: name }));
    const breathing = Object.assign(document.createElement("div"), { className: "mm-smooth-breath" });
    breathing.append(breath, both);
    out.glow = [base, lift, breathing];
  }
  out.rings = source.orbits.map((_, i) => out.rings[i] ?? document.createElement("canvas"));
  out.live = source.live ? out.live ?? document.createElement("canvas") : null;
  const [base, lift, breathing] = out.glow as [HTMLCanvasElement, HTMLCanvasElement, HTMLElement];
  for (const [i, canvas] of [base, lift, ...([...breathing.children] as HTMLCanvasElement[]), ...out.rings, ...(out.live ? [out.live] : [])].entries()) {
    const bitmap = layers[i], context = canvas.getContext("bitmaprenderer");
    if (!context) return null;
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    if (canvas !== out.live) canvas.style.height = `${bitmap.height / source.dpr}px`;
    if (out.rings.includes(canvas)) canvas.style.width = `${bitmap.width / source.dpr}px`;
    context.transferFromImageBitmap(bitmap);
  }
  out.key = key;
  return out;
}

/** Paints the glow into the map's .mm-smooth holders and repaints on a new size, scale or skin; `fail` hands the map back to its CSS glow. */
export function smoothGlow(mm: HTMLElement, fail: () => void) {
  const find = (name: string) => mm.querySelector<HTMLElement>(name)!;
  const holder = find(".mm-smooth"), card = find(".mm-smooth-live"), glow = find(".mm-glow"), ray = find(".mm-ray"), brain = find(".mm-brain"), live = find(".mm-live"), orbits = [...mm.querySelectorAll<HTMLElement>(".mm-orbit")];
  const sizes = new Map<Element, number[]>();
  let timer = 0, first = true, gone = false;
  // a map shows canvases of its own: it takes the kept ones here and hands its own back when it leaves
  let mine = painted;
  painted = undefined;
  const drop = () => { unsupported = true; fail(); };

  // the page colour behind the map
  function backdrop() {
    for (let el: Element | null = mm; el; el = el.parentElement) { const c = color(getComputedStyle(el).backgroundColor); if (c[3] === 1) return c.slice(0, 3); }
    return [0, 0, 0];
  }

  function read(): Source | null {
    const size = sizes.get(holder), box = holder.getBoundingClientRect();
    if (!size?.[0] || !box.width) return null;
    // an ancestor mid-transition scales the rects, never the layout
    const scale = holder.offsetWidth / box.width, cents = (value: number) => Math.round(value * 100) / 100;
    const within = (el: Element, of = box) => { const r = el.getBoundingClientRect(); return [(r.left - of.left) * scale, (r.top - of.top) * scale, r.width * scale, r.height * scale].map(cents); };
    const style = getComputedStyle, grain = style(mm, "::after"), halo = style(brain, "::after"), across = sizes.get(card);
    return {
      dpr: devicePixelRatio, size, back: backdrop(),
      aura: [style(glow).backgroundImage, ...within(glow)],
      lift: Number(style(mm).getPropertyValue("--mm-lift")),
      ray: style(ray).display === "none" ? null : [style(ray).backgroundImage, Number(/blur\(([\d.]+)px\)/.exec(style(ray).filter)?.[1] ?? 0), ...within(ray)],
      halo: [halo.backgroundImage, -parseFloat(halo.top)],
      badge: within(brain),
      shadow: style(holder).boxShadow,
      veil: [grain.maskImage, Number(grain.opacity)],
      swell: style(orbits[0]).boxShadow, orbits: orbits.map((each) => each.offsetWidth),
      live: across?.[0] ? [style(card).boxShadow, ...within(live, card.getBoundingClientRect()), parseFloat(style(live).borderTopLeftRadius), ...across] : null,
    };
  }

  // the Live card's glow gets a canvas as far out as its widest blur, kept inside the grid so it adds no scroll
  function place() {
    const grid = card.parentElement!, reach = Math.max(0, ...shadows(getComputedStyle(card).boxShadow).map((each) => 3 * each.sigma + each.spread));
    const left = Math.max(0, live.offsetLeft - reach), top = live.offsetTop - reach;
    const next = [left, top, Math.min(grid.offsetWidth, live.offsetLeft + live.offsetWidth + reach) - left, Math.min(grid.offsetHeight, live.offsetTop + live.offsetHeight + reach) - top].map((each) => `${Math.round(each)}px`);
    const moved = card.style.width !== next[2] || card.style.height !== next[3];
    [card.style.left, card.style.top, card.style.width, card.style.height] = next;
    return moved;
  }

  const show = () => {
    if (!mine || gone) return;
    if (holder.firstChild !== mine.glow[0]) holder.replaceChildren(...mine.glow);
    orbits.forEach((each, i) => { if (each.firstChild !== mine!.rings[i]) each.replaceChildren(mine!.rings[i]); });
    if (card.firstChild !== mine.live) card.replaceChildren(...(mine.live ? [mine.live] : []));
  };
  const later = () => { clearTimeout(timer); timer = window.setTimeout(sync, 150); };
  function sync() {
    const source = read();
    if (gone || !source) return;
    const key = JSON.stringify(source);
    if (mine?.key === key) return show();
    if (busy) return later();
    busy = true;
    void paint(source).then((layers) => {
      busy = false;
      const next = layers && hang(layers, source, key, mine);
      if (!next) return drop();
      mine = next;
      if (gone) painted = next;
      else show();
    });
  }

  const sized = new ResizeObserver((entries) => {
    for (const { target, devicePixelContentBoxSize: [size] } of entries) sizes.set(target, [size.inlineSize, size.blockSize]);
    // a resized card canvas reports its new device size before this frame paints
    if (getComputedStyle(card).display !== "none" && place()) return;
    if (!first) return later();
    first = false;
    sync();
  });
  const watch = () => { for (const each of [holder, card, live]) sized.observe(each, { box: "device-pixel-content-box" }); };
  try {
    // WebKit has no device-pixel box, and a canvas that misses the pixel grid would blur the dither
    watch();
  } catch {
    drop();
    return () => sized.disconnect();
  }
  const skin = new MutationObserver(later);
  skin.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  // a new display scale does not always wake the observer; watching again reports the new device sizes
  const off = new AbortController();
  const rescale = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => { sized.disconnect(); watch(); rescale(); }, { once: true, signal: off.signal });
  rescale();
  return () => { gone = true; clearTimeout(timer); sized.disconnect(); skin.disconnect(); off.abort(); painted = mine ?? painted; };
}
