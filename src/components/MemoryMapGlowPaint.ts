// samples per shape, the aura's dimmest breath (mm-aura), and how far past its box the blurred ray is drawn
const N = 127, WIDE = N + 3, DIM = 0.4, RAY = 1.25;
// the grain tile this replaces lifted the aura by its mean grey at its alpha
const VEIL = [181 / 255, 0.05];

type Rgba = [number, number, number, number];
export interface Stop { c: Rgba; at: number }
/** What the glow is made of, read from the CSS it stands in for; its JSON is the key of a finished painting. */
export interface Source {
  dpr: number;
  size: number[];
  back: number[];
  aura: [string, ...number[]];
  lift: number;
  ray: [string, ...number[]] | null;
  halo: [string, number];
  badge: number[];
  shadow: string;
  veil: [string, number];
  swell: string;
  orbits: number[];
  live: [string, ...number[]] | null;
}
/** The layers in order: dim map, open lift, breath, both, each ring, the Live card; none where WebGL2 is missing. */
export interface Rendered { renderer?: string; layers: { w: number; h: number; data: Uint8ClampedArray<ArrayBuffer> }[] | null }

export const color = (text: string): Rgba => { const n = text.match(/[\d.]+(?:e-?\d+)?/g)!.map(Number); return [n[0] / 255, n[1] / 255, n[2] / 255, n[3] ?? 1]; };
const center = (image: string) => { const m = image.match(/at ([\d.]+)% ([\d.]+)%/); return m ? [Number(m[1]) / 100, Number(m[2]) / 100] : [0.5, 0.5]; };
const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); return Math.sign(x) * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const tint = (lut: Float32Array, i: number, c: Rgba, by: number) => lut.set([c[0] * c[3] * by, c[1] * c[3] * by, c[2] * c[3] * by, c[3] * by], i * 4);
export const shadows = (text: string) => [...text.matchAll(/(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px(?! inset)/g)]
  .map((m) => ({ c: color(m[1]), x: Number(m[2]), y: Number(m[3]), sigma: Number(m[4]) / 2, spread: Number(m[5]) })).filter((each) => each.sigma > 0).reverse();

/** A computed radial-gradient's colours, each with its place along the line. */
export function stops(image: string): Stop[] {
  const found = [...image.matchAll(/(rgba?\([^)]*\))(?:\s+([\d.]+)%)?/g)];
  const at = found.map((m, i) => (m[2] !== undefined ? Number(m[2]) / 100 : i === 0 ? 0 : i === found.length - 1 ? 1 : NaN));
  for (let i = 1; i < at.length; i++) if (Number.isNaN(at[i])) {
    let j = i;
    while (Number.isNaN(at[j])) j++;
    for (let k = i; k < j; k++) at[k] = at[i - 1] + ((at[j] - at[i - 1]) * (k - i + 1)) / (j - i + 1);
  }
  return found.map((m, i) => ({ c: color(m[1]), at: at[i] }));
}

/** Premultiplied colour at N + 1 steps from the centre out to `reach` gradient lengths, blurred along the line by `sigma`. */
export function ramp(list: Stop[], reach = 1, sigma = 0) {
  const step = reach / N, span = sigma ? Math.ceil((3 * sigma) / step) : 0, raw = new Float32Array((N + 1 + span) * 4);
  for (let i = 0, at = 1; i <= N + span; i++) {
    while (at < list.length - 1 && i * step > list[at].at) at++;
    const a = list[at - 1], b = list[at], f = Math.min(1, Math.max(0, (i * step - a.at) / (b.at - a.at || 1)));
    for (let ch = 0; ch < 4; ch++) raw[i * 4 + ch] = (ch < 3 ? a.c[ch] * a.c[3] : a.c[3]) * (1 - f) + (ch < 3 ? b.c[ch] * b.c[3] : b.c[3]) * f;
  }
  if (!span) return raw;
  const lut = new Float32Array((N + 1) * 4), weights = Array.from({ length: span + 1 }, (_, k) => Math.exp(-((k * step) ** 2) / (2 * sigma * sigma)));
  const total = weights.reduce((sum, each) => sum + 2 * each, -weights[0]);
  for (let i = 0; i <= N; i++) for (let k = -span; k <= span; k++) for (let ch = 0; ch < 4; ch++) lut[i * 4 + ch] += (raw[Math.abs(i + k) * 4 + ch] * weights[Math.abs(k)]) / total;
  return lut;
}

/** A blurred disc's colour by distance from its centre, out to `reach` px. */
export function disc(radius: number, sigma: number, c: Rgba) {
  const reach = radius + 3 * sigma, lut = new Float32Array((N + 1) * 4), root = Math.SQRT2 * sigma, M = 24;
  for (let i = 0; i <= N; i++) {
    const r = (i / N) * reach;
    let cover = 0;
    for (let m = 0; m < M; m++) {
      const y = -radius + ((m + 0.5) / M) * 2 * radius, half = Math.sqrt(radius * radius - y * y);
      cover += (Math.exp(-(y * y) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI))) * 0.5 * (erf((r + half) / root) - erf((r - half) / root)) * ((2 * radius) / M);
    }
    tint(lut, i, c, cover);
  }
  return { lut, reach };
}

// one axis of a blurred box: how much of it covers each distance from its middle
function side(half: number, sigma: number, c: Rgba) {
  const lut = new Float32Array((N + 1) * 4), root = Math.SQRT2 * sigma;
  for (let i = 0; i <= N; i++) { const x = (i / N) * (half + 3 * sigma); tint(lut, i, c, 0.5 * (erf((x + half) / root) - erf((x - half) / root))); }
  return lut;
}

// one table row per shape: its colours, then where it sits, then whether it breathes, shows only on an open map, or is a box; the map's own, then the rings', then the Live card's
function table(source: Source) {
  const rows: Float32Array[] = [];
  const row = (lut: Float32Array, place: number[], flags: number[] = []) => { const out = new Float32Array(WIDE * 4); out.set(lut); out.set(place, (N + 1) * 4); out.set(flags, (N + 2) * 4); rows.push(out); };
  let deep = 0;
  const round = (lut: Float32Array, cx: number, cy: number, rx: number, ry: number, ...flags: number[]) => { deep = Math.max(deep, cy + ry); row(lut, [cx, cy, N / rx, N / ry], flags); };
  const [image, x, y, w, h] = source.aura, [ax, ay] = center(image), list = stops(image);
  const aura = [x + w * ax, y + h * ay, Math.min(ax, 1 - ax) * w, Math.min(ay, 1 - ay) * h] as const;
  round(ramp(list), ...aura, 1);
  round(ramp(list.map(({ c, at }) => ({ c: [c[0], c[1], c[2], c[3] * source.lift], at }))), ...aura, 1, 1);
  if (source.ray) {
    const [image, blur, x, y, w, h] = source.ray;
    round(ramp(stops(image), RAY, blur / ((w + h) / 4)), x + w / 2, y + h / 2, (w / 2) * RAY, (h / 2) * RAY);
  }
  const [bx, by, size] = source.badge, cx = bx + size / 2, cy = by + size / 2, halo = size / 2 + source.halo[1];
  round(ramp(stops(source.halo[0])), cx, cy, halo, halo, 1);
  const shallow = Math.max(aura[1] + aura[3], cy + halo);
  round(ramp(stops(source.veil[0]).map(({ c, at }) => ({ c: [VEIL[0], VEIL[0], VEIL[0], VEIL[1] * source.veil[1] * c[3]], at }))), ...aura);
  for (const each of shadows(source.shadow)) { const made = disc(size / 2 + each.spread, each.sigma, each.c); round(made.lut, cx + each.x, cy + each.y, made.reach, made.reach); }
  const glow = rows.length;
  // each swelling ring: where its rows start and end, and its canvas's side in device px
  const rings = source.orbits.map((size) => {
    const from = rows.length, list = shadows(source.swell), side = Math.ceil(2 * Math.max(...list.map((each) => size / 2 + each.spread + 3 * each.sigma)) * source.dpr), mid = side / source.dpr / 2;
    for (const each of list) { const made = disc(size / 2 + each.spread, each.sigma, each.c); row(made.lut, [mid, mid, N / made.reach, N / made.reach]); }
    return [from, rows.length, side];
  });
  const lit = rows.length;
  if (source.live) {
    const [shadow, x, y, w, h, radius] = source.live;
    for (const each of shadows(shadow)) {
      const hw = w / 2 + each.spread, hh = h / 2 + each.spread;
      row(side(hw, each.sigma, each.c), [x + w / 2 + each.x, y + h / 2 + each.y, N / (hw + 3 * each.sigma), N / (hh + 3 * each.sigma)], [0, 0, 1]);
      row(side(hh, each.sigma, [1, 1, 1, 1]), [w / 2, h / 2, radius]);
    }
  }
  const data = new Float32Array(WIDE * 4 * rows.length);
  rows.forEach((each, i) => data.set(each, i * WIDE * 4));
  return { data, rows: rows.length, glow, rings, lit, deep, shallow };
}

const VERTEX = `#version 300 es
layout(location = 0) in vec2 corner; layout(location = 1) in vec3 frame; layout(location = 2) in vec3 span; layout(location = 3) in vec3 back;
flat out vec3 job; flat out vec3 rows; flat out vec3 backdrop;
void main() { job = frame; rows = span; backdrop = back; gl_Position = vec4(corner, 0.0, 1.0); }`;
// job: device px per CSS px, noise seed, layer (0 dim map, 1 what an open map adds, 2 what a full breath adds, 3 what both add on top); rows: first, end, dither strength
const FRAGMENT = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D ramps;
flat in vec3 job; flat in vec3 rows; flat in vec3 backdrop;
out vec4 pixel;
vec4 look(int row, float rho) {
  if (rho >= ${N}.0) return vec4(0.0);
  int k = int(rho);
  return mix(texelFetch(ramps, ivec2(k, row), 0), texelFetch(ramps, ivec2(k + 1, row), 0), rho - float(k));
}
vec4 stack(vec2 at, float dim, float lift) {
  vec4 sum = vec4(0.0);
  for (int i = int(rows.x); i < int(rows.y); i++) {
    vec4 place = texelFetch(ramps, ivec2(${N + 1}, i), 0), flags = texelFetch(ramps, ivec2(${N + 2}, i), 0), s;
    vec2 d = abs(at - place.xy);
    if (flags.z > 0.5) {
      vec4 card = texelFetch(ramps, ivec2(${N + 1}, i + 1), 0);
      vec2 q = d - card.xy + card.z;
      float outside = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - card.z;
      s = look(i, d.x * place.z) * look(i + 1, d.y * place.w).a * clamp(outside * job.x + 0.5, 0.0, 1.0);
      i++;
    } else s = look(i, length(d * place.zw)) * mix(1.0, dim, flags.x) * mix(1.0, lift, flags.y);
    sum = s + sum * (1.0 - s.a);
  }
  return sum;
}
vec4 added(vec4 high, vec4 low) { float keep = (1.0 - high.a) / max(1.0 - low.a, 0.0001); return vec4(high.rgb - keep * low.rgb, 1.0 - keep); }
uvec3 pcg(uvec3 v) { v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
void main() {
  vec2 px = gl_FragCoord.xy, at = px / job.x;
  int layer = int(job.z);
  vec4 want = stack(at, ${DIM}, 0.0);
  if (layer == 1) want = added(stack(at, ${DIM}, 1.0), want);
  else if (layer == 2) want = added(stack(at, 1.0, 0.0), want);
  else if (layer == 3) {
    vec4 breath = added(stack(at, 1.0, 0.0), want), open = stack(at, ${DIM}, 1.0);
    want = added(stack(at, 1.0, 1.0), breath + open * (1.0 - breath.a));
  }
  want = clamp(want, 0.0, 1.0);
  if (want.a <= 0.0) { pixel = vec4(0.0); return; }
  uvec3 cell = uvec3(px, job.y);
  vec3 a = vec3(pcg(cell) >> 8u) / 16777216.0, b = vec3(pcg(cell + uvec3(0u, 0u, 7u)) >> 8u) / 16777216.0, c = vec3(pcg(cell + uvec3(0u, 0u, 13u)) >> 8u) / 16777216.0;
  float alpha = clamp(floor(want.a * 255.0 + (c.x - c.y) * rows.z + 0.5), 0.0, 255.0);
  // what rounding the alpha shows or hides of the page goes back into the colour, or the two dithers stack on a light skin
  vec3 level = floor(want.rgb * 255.0 + backdrop * (alpha - want.a * 255.0) + vec3(a.x - a.y, a.z - b.x, b.y - b.z) * rows.z + 0.5);
  pixel = vec4(clamp(level, 0.0, alpha), alpha) / 255.0;
}`;


/** Paints every layer; blocks while the shader builds, so it runs in MemoryMapGlow.worker.ts. */
export function render(source: Source): Rendered {
  const { dpr, size: [wide, high], live } = source, made = table(source);
  const tall = (bottom: number) => Math.min(high, Math.ceil(bottom * dpr));
  const jobs = [[wide, tall(made.deep), 0, 0, made.glow, 1], ...[1, 2, 3].map((layer) => [wide, tall(made.shallow), layer, 0, made.glow, 1])];
  // a ring's dither fades with the ring, so it starts stronger
  for (const [from, to, side] of made.rings) jobs.push([side, side, 0, from, to, 2]);
  if (live) jobs.push([live[6], live[7], 0, made.lit, made.rows, 1]);
  const gl = new OffscreenCanvas(Math.max(...jobs.map((each) => each[0])), Math.max(...jobs.map((each) => each[1]))).getContext("webgl2", { antialias: false, depth: false, stencil: false });
  if (!gl) return { layers: null };
  const info = gl.getExtension("WEBGL_debug_renderer_info"), renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  const program = gl.createProgram()!;
  for (const [type, text] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) { const shader = gl.createShader(type)!; gl.shaderSource(shader, text); gl.compileShader(shader); gl.attachShader(program, shader); }
  gl.linkProgram(program);
  let layers: Rendered["layers"] = null;
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, WIDE, made.rows, 0, gl.RGBA, gl.FLOAT, made.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.vertexAttrib3fv(3, source.back);
    layers = jobs.map(([w, h, layer, from, to, grit], seed) => {
      gl.viewport(0, 0, w, h);
      gl.vertexAttrib3f(1, dpr, seed + 1, layer);
      gl.vertexAttrib3f(2, from, to, grit);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const data = new Uint8ClampedArray(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      // the surface holds colour already times alpha, an ImageData holds it plain
      for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; if (a > 0 && a < 255) for (let k = 0; k < 3; k++) data[i + k] = Math.round((data[i + k] * 255) / a); }
      return { w, h, data };
    });
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { renderer, layers };
}
