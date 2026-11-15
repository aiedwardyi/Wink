// Samurai Ink: a ronin under the moon, painted in ink on two plates. The far
// plate and the moon are drawn once per size into red, the ronin's ink into
// green (coverage) and blue (its tone). The shader drifts cloud and mist, moves
// the far plate against him, blows the leaves, his hair and his robes, and cuts
// the air every few seconds while Wink works.
import { flowScene } from "./flow";
import farTallUrl from "./plates/samurai-ink-far-tall.webp";
import farWideUrl from "./plates/samurai-ink-far-wide.webp";
import coilUrl from "./plates/samurai-ink-ronin-coil.webp";
import cutUrl from "./plates/samurai-ink-ronin-cut.webp";
import roninUrl from "./plates/samurai-ink-ronin.webp";
import slashUrl from "./plates/samurai-ink-slash.webp";

const PERIOD = 120;
// Seconds between cuts: a divisor of PERIOD, so the clock's wrap keeps the beat.
const CUT = 5;

// The ronin plate in its own pixels: size, the line of his back (cloth and hair beyond it fly free), his nose and his head.
const RONIN = { w: 1001, h: 1521, back: 560, nose: [285, 290], head: [370, 230] };
// The cut's sweep in his plate's pixels: the blade turns about c with its tip on a circle of radius r, rising from angle a0 to a1, where the cut plate's blade points.
const SWEEP = { c: [69, 375], r: 539, a0: 2.226, a1: 4.226 };
// The slash plate, straightened along its top edge: len px from its dry tail to its wet head, out px above that edge and in px below. Bent along the sweep with that edge on the tip's path, in STRIP rows under the poses.
const SLASH = { len: 1496, out: 90, in: 250 };
const STRIP = 256;
const BAND = (SWEEP.r * (SWEEP.a1 - SWEEP.a0)) / SLASH.len;
// Where the coil and the cut plates' top left corners sit in his plate, at the same scale: he sinks into the coil and lunges into the cut.
const POSES = { coil: [-20, 65], cut: [-190, -105] };
// The tall far plate paints its own moon: plate size, then the moon's centre and radius.
const FAR_TALL = { w: 1024, h: 1536, moon: [865, 125, 145] };

// The backdrop paints synchronously, so the plates are decoded before this module resolves; only WebGL can show them.
const decode = (url: string) =>
  fetch(url)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .catch(() => null);
const [farWide, farTall, ronin, coil, cut, slash] = "WebGLRenderingContext" in globalThis ? await Promise.all([farWideUrl, farTallUrl, roninUrl, coilUrl, cutUrl, slashUrl].map(decode)) : [null, null, null, null, null, null];

// Shared with the shader: the ronin plate's top left and scale, and the moon behind him.
// His face sits at the chat column's text edge (960 px at most with 20 px padding, centred; chat-column.ts), where user bubbles end; his back runs off the edge.
const LAYOUT = `
vec3 figure(vec2 s) {
  bool tall = s.x < s.y;
  float k = (tall ? 0.75 : 0.58) * s.y / ${RONIN.h}.0;
  float x = (tall ? 0.86 * s.x : min(max(0.5 * (s.x + min(s.x, 960.0)) - 20.0, s.x - 0.33 * s.y), s.x - 0.1 * s.y)) - ${RONIN.nose[0]}.0 * k;
  return vec3(x, (tall ? 0.12 : 0.15) * s.y, k);
}
vec3 moon(vec2 s) {
  if (s.x < s.y) {
    float k = max(s.x / ${FAR_TALL.w}.0, s.y / ${FAR_TALL.h}.0);
    return vec3(s.x - ${FAR_TALL.w - FAR_TALL.moon[0]}.0 * k, s.y - ${FAR_TALL.h - FAR_TALL.moon[1]}.0 * k, ${FAR_TALL.moon[2]}.0 * k);
  }
  vec3 f = figure(s);
  vec2 c = f.xy + vec2(${RONIN.head[0]}.0, ${RONIN.head[1]}.0) * f.z;
  return vec3(min(c.x + 0.02 * s.y, s.x - 0.115 * s.y), c.y - 0.03 * s.y, 0.1 * s.y);
}`;

function layout(w: number, h: number) {
  const tall = w < h;
  const k = ((tall ? 0.75 : 0.58) * h) / RONIN.h;
  const f = { x: (tall ? 0.86 * w : Math.min(Math.max(0.5 * (w + Math.min(w, 960)) - 20, w - 0.33 * h), w - 0.1 * h)) - RONIN.nose[0] * k, y: (tall ? 0.12 : 0.15) * h, k };
  const c = [f.x + RONIN.head[0] * k, f.y + RONIN.head[1] * k];
  return { f, m: { x: Math.min(c[0] + 0.02 * h, w - 0.115 * h), y: c[1] - 0.03 * h, r: 0.1 * h } };
}

type Ctx = CanvasRenderingContext2D;
const TAU = Math.PI * 2;
const tone = (L: number, a = 1) => {
  const v = Math.round(Math.max(0, Math.min(1, L)) * 255);
  return `rgba(${v}, ${v}, ${v}, ${a})`;
};

function sheet(g: Ctx, dpr: number, opaque = false) {
  const c = document.createElement("canvas");
  c.width = g.canvas.width;
  c.height = g.canvas.height;
  const s = c.getContext("2d")!;
  if (opaque) s.fillRect(0, 0, c.width, c.height);
  s.setTransform(dpr, 0, 0, dpr, 0, 0);
  s.fillStyle = s.strokeStyle = "#fff";
  return s;
}

function paint(g: Ctx, w: number, h: number) {
  const { f, m } = layout(w, h);
  const dpr = g.canvas.width / w;
  const put = (dst: Ctx, src: Ctx, op: GlobalCompositeOperation = "source-over") => {
    dst.save();
    dst.setTransform(1, 0, 0, 1, 0, 0);
    dst.globalCompositeOperation = op;
    dst.drawImage(src.canvas, 0, 0);
    dst.restore();
  };
  // Canvas filters are missing in Safari, so blur rides on the shadow of a copy drawn off the canvas.
  const blur = (dst: Ctx, src: Ctx, css: number, color: string) => {
    const W = src.canvas.width;
    dst.save();
    dst.setTransform(1, 0, 0, 1, 0, 0);
    dst.shadowColor = color;
    dst.shadowBlur = css * dpr;
    dst.shadowOffsetX = W;
    dst.drawImage(src.canvas, -W, 0);
    dst.restore();
  };
  const glow = (s: Ctx, x: number, y: number, r0: number, r1: number, L: number) => {
    const gr = s.createRadialGradient(x, y, r0, x, y, r1);
    for (const [o, a] of [[0, 1], [0.1, 0.62], [0.25, 0.34], [0.45, 0.14], [0.7, 0.04], [1, 0]]) gr.addColorStop(o, tone(L, a));
    s.fillStyle = gr;
    s.fillRect(x - r1, y - r1, r1 * 2, r1 * 2);
  };

  // Red: the far plate, anchored on its lit corner, and the moon.
  const sky = sheet(g, dpr, true);
  const far = w < h ? farTall : farWide;
  if (far) {
    const k = Math.max(w / far.width, h / far.height);
    sky.drawImage(far, w - far.width * k, h - far.height * k, far.width * k, far.height * k);
    if (w >= h) {
      // The ranges rise on the left too, fainter and farther, so the picture runs the full width.
      const k2 = k * 0.8;
      const left = sheet(g, dpr);
      left.scale(-1, 1);
      left.drawImage(far, -far.width * k2, h - far.height * k2, far.width * k2, far.height * k2);
      left.setTransform(dpr, 0, 0, dpr, 0, 0);
      left.globalCompositeOperation = "destination-in";
      const fade = left.createLinearGradient(0, h * 0.35, 0, h * 0.7);
      fade.addColorStop(0, tone(0, 0));
      fade.addColorStop(1, tone(0, 1));
      left.fillStyle = fade;
      left.fillRect(0, 0, w, h);
      sky.save();
      sky.setTransform(1, 0, 0, 1, 0, 0);
      sky.globalCompositeOperation = "lighten";
      sky.globalAlpha = 0.35;
      sky.drawImage(left.canvas, 0, 0);
      sky.restore();
    }
  } else {
    const grad = sky.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, tone(0.03));
    grad.addColorStop(1, tone(0.12));
    sky.fillStyle = grad;
    sky.fillRect(0, 0, w, h);
  }
  // The tall plate paints its own moon.
  if (!(w < h && farTall)) {
    sky.globalCompositeOperation = "screen";
    glow(sky, m.x, m.y, m.r, m.r * 7, 0.3);
    glow(sky, m.x, m.y, m.r, m.r * 2, 0.45);
    sky.globalCompositeOperation = "source-over";
    const disc = sky.createRadialGradient(m.x - m.r * 0.25, m.y - m.r * 0.25, 0, m.x, m.y, m.r);
    disc.addColorStop(0, tone(0.97));
    disc.addColorStop(0.75, tone(0.92));
    disc.addColorStop(1, tone(0.84));
    sky.fillStyle = disc;
    sky.beginPath();
    sky.arc(m.x, m.y, m.r, 0, TAU);
    sky.fill();
    // The maria, soft, kept inside the disc.
    const mar = sheet(g, dpr);
    for (const [x, y, rx, ry, a] of [[-0.3, -0.36, 0.26, 0.22, 0.6], [0.18, -0.33, 0.15, 0.14, 0.55], [0.32, -0.05, 0.19, 0.16, 0.5], [0.63, -0.24, 0.09, 0.08, 0.6], [0.5, 0.14, 0.12, 0.15, 0.4], [0.3, 0.27, 0.08, 0.07, 0.35], [-0.56, 0.02, 0.22, 0.36, 0.45], [-0.14, 0.42, 0.16, 0.12, 0.4], [-0.42, 0.44, 0.09, 0.08, 0.45], [-0.06, -0.64, 0.3, 0.06, 0.35], [0.02, 0.08, 0.1, 0.08, 0.3]]) {
      mar.globalAlpha = a;
      mar.beginPath();
      mar.ellipse(m.x + x * m.r, m.y + y * m.r, rx * m.r, ry * m.r, x, 0, TAU);
      mar.fill();
    }
    const maria = sheet(g, dpr);
    blur(maria, mar, m.r * 0.09, tone(0.72, 0.6));
    maria.globalCompositeOperation = "destination-in";
    maria.beginPath();
    maria.arc(m.x, m.y, m.r - 0.6, 0, TAU);
    maria.fill();
    put(sky, maria);
  }

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = "#000";
  g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  const into = (s: Ctx, c: string, op: GlobalCompositeOperation) => {
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = op;
    s.fillStyle = c;
    s.fillRect(0, 0, s.canvas.width, s.canvas.height);
    put(g, s, "lighter");
  };
  into(sky, "#f00", "multiply");
  if (ronin) {
    // Green: his coverage. Blue: his ink's own tone, premultiplied by it.
    const cover = sheet(g, dpr);
    const ink = sheet(g, dpr, true);
    for (const s of [cover, ink]) s.drawImage(ronin, f.x, f.y, ronin.width * f.k, ronin.height * f.k);
    into(cover, "#0f0", "source-in");
    into(ink, "#00f", "multiply");
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Red and green: the coil's coverage and its ink premultiplied by it. Blue and alpha: the same for the cut. Below them, the slash plate stretched to the width: red sharp, green blurred for its glow.
function poses(w: number, h: number, dpr: number) {
  if (!coil || !cut) return null;
  const { f } = layout(w, h);
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  const draw = (img: ImageBitmap, [x, y]: number[]) => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const s = c.getContext("2d", { willReadFrequently: true })!;
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.drawImage(img, f.x + x * f.k, f.y + y * f.k, img.width * f.k, img.height * f.k);
    return s.getImageData(0, 0, W, H).data;
  };
  const a = draw(coil, POSES.coil);
  const b = draw(cut, POSES.cut);
  const out = new ImageData(W, H + STRIP);
  const o = out.data;
  for (let i = 0; i < a.length; i += 4) {
    const ca = Math.max(0, a[i + 3] * 1.25 - 64);
    const cb = Math.max(0, b[i + 3] * 1.25 - 64);
    o[i] = ca;
    o[i + 1] = (a[i] * ca * ca) / 65025;
    o[i + 2] = cb;
    o[i + 3] = (b[i] * cb * cb) / 65025;
  }
  if (slash) {
    const s = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    s.canvas.width = W;
    s.canvas.height = STRIP;
    s.drawImage(slash, 0, 0, W, STRIP);
    const sharp = s.getImageData(0, 0, W, STRIP).data;
    s.clearRect(0, 0, W, STRIP);
    s.shadowColor = "#fff";
    s.shadowBlur = STRIP * 0.15;
    s.shadowOffsetX = W;
    s.drawImage(slash, -W, 0, W, STRIP);
    const soft = s.getImageData(0, 0, W, STRIP).data;
    for (let i = 3, j = a.length; i < sharp.length; i += 4, j += 4) {
      o[j] = sharp[i];
      o[j + 1] = soft[i];
    }
  }
  return out;
}

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uT, uFlow, uLaneX, uLaneW;
uniform sampler2D uTex, uTex2;
uniform vec3 uCool, uWarm;
${LAYOUT}
const float TAU = 6.2831853;
const float W = TAU / ${PERIOD}.0;
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
// Value noise that repeats every per cells in x, so drifting cloud and mist loop with the clock.
float n2(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, per), x1 = mod(i.x + 1.0, per);
  return mix(mix(h12(vec2(x0, i.y)), h12(vec2(x1, i.y)), f.x), mix(h12(vec2(x0, i.y + 1.0)), h12(vec2(x1, i.y + 1.0)), f.x), f.y);
}
float fbm(vec2 p, float per) { return 0.62 * n2(p, per) + 0.38 * n2(p * 2.0 + vec2(0.0, 5.3), per * 2.0); }
float cov(vec2 p) { return texture2D(uTex, p / uSize).g; }
float gust() { return 0.55 + 0.3 * sin(uT * W * 16.0) + 0.15 * sin(uT * W * 48.0 + 1.3); }
// How far the wind moves his ink at px: nothing along his back, more toward the tips of what flies free of it.
vec2 sway(vec2 px, vec3 f, float g) {
  vec2 l = (px - f.xy) / f.z;
  float s = l.x - ${RONIN.back}.0;
  if (s < 0.0 || l.y < 0.0 || l.y > ${RONIN.h}.0) return vec2(0.0);
  float t = uT * W;
  float free = pow(min(s / 200.0, 1.0), 1.3);
  vec2 d;
  d.y = free * ((3.0 + 4.0 * g) * sin(s * 0.024 - t * 96.0 + l.y * 0.004) + 1.4 * sin(s * 0.075 - t * 216.0 + 1.7));
  d.x = free * ((g - 0.55) * 9.0 + 1.6 * sin(l.y * 0.02 - t * 120.0));
  return d * f.z;
}
float stalk(vec2 gp, float gw, float x0, float ht, float lean) {
  float yy = gp.y / (ht * gw);
  if (yy > 1.0) return 0.0;
  float wdt = 0.014 * gw * (1.0 - 0.85 * yy) + 0.6;
  return 1.0 - smoothstep(wdt * 0.6, wdt * 1.8 + 2.0, abs(gp.x - (x0 + lean * ht * yy * yy) * gw));
}
// One depth of leaves blown left to right, in drifts: coverage, how much of the face catches the moon, and its lit rim.
vec3 leaf(vec2 px, float cs, float sz, float soft, float seed) {
  vec2 p = px - vec2(96.0, 36.0) * cs / ${PERIOD}.0 * uT;
  p.y += sin(p.x * TAU / (cs * 3.0) + uT * W * 7.0 + seed) * cs * 0.2;
  vec2 cell = floor(p / cs);
  vec2 key = mod(cell, vec2(96.0, 36.0));
  float hs = h12(key + seed * 17.0);
  if (hs < 0.5) return vec3(0.0);
  float dx = key.x / 8.0, fx = fract(dx);
  fx = fx * fx * (3.0 - 2.0 * fx);
  float drift = smoothstep(0.3, 0.75, mix(h12(vec2(mod(floor(dx), 12.0), seed * 3.0)), h12(vec2(mod(floor(dx) + 1.0, 12.0), seed * 3.0)), fx));
  float thr = 0.8 - 0.42 * drift - 0.3 * uFlow;
  if (hs < thr) return vec3(0.0);
  vec2 q = p - (cell + 0.3 + 0.4 * vec2(h12(key + 3.7), h12(key + 9.1))) * cs;
  // No leaf or stem reaches 2.3 sizes from its centre, so most of the cell skips the shape.
  float rq = 2.5 * sz + 2.0 * soft + 1.0;
  if (dot(q, q) > rq * rq) return vec3(0.0);
  float spin = uT * W * floor(3.0 + 9.0 * h12(key + 5.5)) * (hs > 0.8 ? 1.0 : -1.0) + hs * TAU;
  q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * q;
  float flip = cos(uT * W * floor(16.0 + 30.0 * hs) + hs * 13.0);
  float fl = max(0.15, abs(flip));
  float s = sz * (0.35 + 1.3 * pow(h12(key + 2.3), 1.5));
  float x = clamp(q.y / s, -1.0, 1.0);
  float wd = 0.16 + 0.34 * h12(key + 4.4);
  float bend = (h12(key + 7.7) - 0.5) * 0.7 + 0.08;
  float hw = s * (wd * sqrt(1.0 - x * x) * (1.0 + 0.3 * x)) * fl;
  float d = max(abs(q.x - s * bend * (1.0 - x * x) * fl) - hw, abs(q.y) - s);
  float stem = max(abs(q.x), abs(q.y - s * 1.15) - s * 0.2) - 0.35;
  float rib = exp(-abs(q.x - s * bend * (1.0 - x * x) * fl) / max(0.6, hw * 0.12)) * 0.35;
  float e = min(d, stem);
  float c = (1.0 - smoothstep(-soft, soft, e)) * smoothstep(thr, thr + 0.05, hs);
  if (c <= 0.0) return vec3(0.0);
  return vec3(c, flip * flip * (1.0 - rib) * (0.7 + 0.6 * fract(hs * 37.0)), c * (1.0 - smoothstep(0.0, 1.2 + 2.0 * soft, -e)) * (0.6 + 0.4 * flip));
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  vec2 uv = px / uSize;
  float H = uSize.y;
  vec3 f = figure(uSize);
  vec3 m = moon(uSize);
  float g = gust();
  float since = mod(uT + 2.1, ${CUT}.0);
  float flash = exp(-since * 6.0) * uFlow;
  // The far plate drifts a little against him.
  vec2 drift = vec2(sin(uT * W * 2.0), 0.5 * sin(uT * W * 3.0 + 1.0)) * H * 0.012;
  float v = texture2D(uTex, (px + drift) / uSize).r;
  v = smoothstep(0.05, 0.95, v);
  float md = length(px - m.xy);
  // The chat column, easing out over its right part so his face just right of it stays lit.
  float lx = px.x - uLaneX + uLaneW;
  float lane = smoothstep(-100.0, 40.0, lx) * (1.0 - smoothstep(2.0 * uLaneW - 200.0, 2.0 * uLaneW - 40.0, lx));
  // Right of where the bot's messages end (min(42rem, 78%), ChatBubble) only solid user bubbles land: dimmed less there, except low down where the newest lands.
  float tx = 72.0 + min(672.0, 0.78 * (2.0 * uLaneW - 120.0));
  float bub = smoothstep(tx, tx + 120.0, lx) * (1.0 - smoothstep(0.6 * H, 0.7 * H, px.y));
  // Fewer leaves behind the transcript.
  float park = 1.0 - 0.6 * lane * (1.0 - bub);
  // Thin cloud crossing the moon, lit where it passes in front of it.
  float cy = (px.y - m.y) / m.z;
  float cx = abs(px.x - m.x) / m.z;
  if (cy > -1.6 && cy < 1.4 && cx < 3.0) {
    vec2 cp = vec2((px.x - uT * m.z * 2.2 * 8.0 / ${PERIOD}.0) / (m.z * 2.2), px.y / (m.z * 0.3));
    float c = fbm(vec2(cp.x, cp.y + 1.3 * n2(cp * vec2(1.0, 0.5) + 4.0, 8.0)), 8.0);
    c = smoothstep(0.56, 0.86, c) * (1.0 - smoothstep(0.6, 1.5, abs(cy + 0.1))) * (1.0 - smoothstep(2.2, 3.0, cx));
    float lit = exp(-max(md - m.z * 0.75, 0.0) / (m.z * 0.5));
    v = mix(v, mix(0.07, 0.95, lit), c * 0.55);
  }
  // Mist drifting across the ranges, faster nearer.
  float ma = (px.y - 0.66 * H) / (0.05 * H);
  if (abs(ma) < 1.6) {
    float n = fbm(vec2((px.x - uT * H * 0.4 * 8.0 / ${PERIOD}.0) / (H * 0.4), px.y / (H * 0.05)), 8.0);
    v = mix(v, 0.34 + 0.34 * exp(-md / (m.z * 2.5)), smoothstep(0.38, 0.8, n) * exp(-ma * ma) * 0.6 * (1.0 - 0.5 * lane));
  }
  if (park > 0.0) {
    vec3 lf = leaf(px, 56.0, 6.0, 0.6, 1.0);
    v = mix(v, mix(0.12, 0.62, lf.y), lf.x * 0.85 * park);
  }
  // His ink, where the wind has moved it, rimmed by the moon behind him.
  vec2 q = px - sway(px, f, g + flash * 0.6);
  float fy = (q.y - f.y) / (f.z * ${RONIN.h}.0);
  // He coils for half a beat, snaps into the cut on the flash and holds it while the sweep dries behind the blade.
  float tg = since > 4.0 ? since - ${CUT}.0 : since;
  float act = smoothstep(0.3, 0.6, uFlow);
  float wc = act * smoothstep(-0.5, -0.42, tg) * (1.0 - step(0.0, tg));
  float wx = act * step(0.0, tg) * (1.0 - smoothstep(1.0, 1.15, tg));
  float wr = 1.0 - wc - wx;
  vec4 P = texture2D(uTex2, q / uSize * vec2(1.0, uBuf.y / (uBuf.y + ${STRIP}.0)));
  vec2 R = texture2D(uTex, q / uSize).gb * wr + P.rg * wc + P.ba * wx;
  float figA = 0.0;
  if (R.x > 0.004) {
    float ink = R.y / R.x;
    bool tall = uSize.x < uSize.y;
    float a = R.x * (1.0 - smoothstep(tall ? 0.58 : 0.66, tall ? 0.72 : 0.95, fy));
    figA = a;
    float r = max(1.0, 2.2 * f.z);
    float tE = cov(q + vec2(r, 0.0)), tW = cov(q - vec2(r, 0.0)), tS = cov(q + vec2(0.0, r)), tN = cov(q - vec2(0.0, r));
    float n = min(min(tE, tW), min(tS, tN));
    float lit = clamp(dot(vec2(tW - tE, tN - tS), normalize(m.xy - px + 0.001)) * 1.5, 0.0, 1.0) * exp(-md / (m.z * 3.0));
    // The ready plate's own edges; the other poses carry their rim light painted in.
    float rim = clamp(a - n, 0.0, 1.0) * wr;
    float back = v;
    v = mix(v, mix(ink * ink, ink, smoothstep(0.55, 0.9, ink)) * 0.92, a);
    v += rim * (back * 0.8 + 0.03 + lit * 0.4 + flash * 0.4);
  }
  // The cut: the blade's sweep left in the air, the slash plate bent along the tip's path behind him; it glows as it lands, then dries away, thin bristles and the tail first.
  float cutM = 0.0;
  float sl = wx * smoothstep(76.0, 130.0, px.y) * (1.0 - figA);
  vec2 c = (px - f.xy) / f.z - vec2(${SWEEP.c[0]}.0, ${SWEEP.c[1]}.0);
  // In from the tip's path, in his plate's px.
  float d = ${SWEEP.r}.0 - length(c);
  if (sl > 0.0 && d > ${(-SLASH.out * BAND).toFixed(1)} && d < ${(SLASH.in * BAND).toFixed(1)}) {
    float a = atan(c.y, c.x);
    a += a < 0.0 ? TAU : 0.0;
    float s = (a - ${SWEEP.a0}) / ${(SWEEP.a1 - SWEEP.a0).toFixed(3)};
    if (s > 0.0 && s < 1.0) {
      float row = (d + ${(SLASH.out * BAND).toFixed(1)}) / ${((SLASH.out + SLASH.in) * BAND).toFixed(1)} * ${STRIP - 1}.0;
      vec2 br = texture2D(uTex2, vec2(s, (uBuf.y + 0.5 + row) / (uBuf.y + ${STRIP}.0))).rg;
      float th = 0.08 + smoothstep(0.25, 1.1, tg) * (0.75 + 0.3 * (1.0 - s));
      cutM = smoothstep(th, th + 0.3, br.x) * sl;
      v = mix(v, 0.95, cutM);
      v += br.y * (1.0 - smoothstep(0.0, 0.45, tg)) * 0.3 * sl;
    }
  }
  v += flash * 0.04;
  float off = park * (1.0 - figA * (1.0 - uFlow));
  if (off > 0.0) {
    vec3 lm = leaf(px, 130.0, 16.0, 0.8, 2.0);
    v = mix(v, mix(0.015, 0.4, lm.y), lm.x * off);
    v += lm.z * 0.55 * off;
    vec3 ln = leaf(px, 300.0, 40.0, 4.0 + 4.0 * uFlow, 3.0);
    v = mix(v, mix(0.015, 0.3, ln.y), ln.x * 0.95 * off);
    v += ln.z * 0.3 * off;
  }
  // Grass close to the lens in the bottom corners, out of focus, bending while he waits.
  float gw = min(uSize.x, H);
  float gx = min(px.x, uSize.x - px.x);
  if (gx < 0.24 * gw && px.y > H - 0.42 * gw) {
    vec2 gp = vec2(gx, H - px.y);
    float gt = uT * W * 10.0;
    vec2 gsc = vec2(cos(gt), sin(gt)) * 0.06 * uFlow;
    float gs = max(max(stalk(gp, gw, 0.012, 0.24, 0.54 + gsc.y), stalk(gp, gw, 0.056, 0.288, 0.408 + dot(gsc, vec2(0.992, -0.129)))), max(stalk(gp, gw, 0.1, 0.213, 0.486 + dot(gsc, vec2(-0.256, -0.967))), max(stalk(gp, gw, 0.144, 0.191, 0.697 + dot(gsc, vec2(-0.926, 0.378))), stalk(gp, gw, 0.188, 0.182, 0.516 + dot(gsc, vec2(0.494, 0.869))))));
    v = mix(v, 0.005, gs * 0.95);
  }
  // Wind: long pale brush gusts racing through his hair and robe while he waits, kept off the header and the composer, faint behind the transcript.
  float wind = 0.0;
  float band = smoothstep(0.08 * H, 0.14 * H, px.y) * (1.0 - smoothstep(0.76 * H, 0.84 * H, px.y)) * (1.0 - 0.6 * lane * (1.0 - bub));
  if (band > 0.0 && uFlow > 0.0) {
    float wa = px.x / (H * 0.09) + uT * W * 6.0;
    vec2 sc = vec2(sin(wa), cos(wa));
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float rowH = H * (0.07 + fi * 0.045);
      float yy = px.y + dot(sc, vec2(cos(fi * 2.0), sin(fi * 2.0))) * H * 0.03;
      float r = floor(yy / rowH);
      float hr = h12(vec2(r, fi * 7.0 + 1.0));
      if (hr < 0.3) continue;
      float span = uSize.x + H;
      float x = fract((px.x - uT * span * floor(18.0 + 12.0 * hr) / ${PERIOD}.0) / span + hr * 7.0);
      float len = 0.2 + 0.24 * h12(vec2(r, fi + 5.0));
      if (x > len) continue;
      float a = x / len;
      float y0 = (r + 0.3 + 0.4 * h12(vec2(r, fi + 3.0))) * rowH;
      float wdt = (2.0 + 5.5 * sin(a * 3.14159)) * (fi > 1.5 ? 6.0 : 1.0 + 0.5 * fi);
      if (abs(yy - y0) > wdt) continue;
      float dryW = smoothstep(0.2, 0.8, n2(vec2(px.x * 0.03, (yy - y0) * 0.3), 4096.0) + 0.5 * a - 0.2);
      float e = abs(yy - y0) / wdt;
      wind += (1.0 - e * e) * pow(a, 1.2) * (0.6 + 0.4 * hr) * dryW * (fi > 1.5 ? 0.4 : 1.0);
    }
  }
  float wl = clamp(wind, 0.0, 1.0) * band * uFlow * (0.6 + 0.4 * g);
  v = mix(v, max(v, min(v + 0.5, 0.8)), wl * 0.85);
  // Low mist rolling along the bottom.
  float gm = (px.y - 0.86 * H) / (0.08 * H);
  if (gm > -1.0) {
    float n = fbm(vec2((px.x - uT * H * 0.2 * 8.0 * 3.0 / ${PERIOD}.0) / (H * 0.2), px.y / (H * 0.03)), 8.0);
    v = mix(v, 0.15, smoothstep(0.4, 0.8, n) * smoothstep(-1.0, 0.5, gm) * 0.36);
  }
  v = max(v - 0.012, 0.0) * 1.012;
  vec3 col = v * mix(uCool, uWarm, smoothstep(0.05, 0.7, v));
  vec2 vq = (uv - vec2(0.62, 0.42)) * vec2(uSize.x / H, 1.0);
  col *= 1.0 - 0.35 * smoothstep(0.4, 1.35, length(vq));
  col += (h12(gl_FragCoord.xy + fract(uT * 7.0) * 517.0) - 0.5) * 0.03;
  // Under the transcript: dimmed, and its brights held down so text keeps its contrast; the cut and the moon show through.
  lane *= (1.0 - 0.9 * cutM) * smoothstep(0.9 * m.z, 1.6 * m.z, md);
  col *= mix(1.0, 0.45 - 0.2 * smoothstep(0.74 * H, 0.84 * H, px.y), lane * (1.0 - 0.55 * bub));
  col /= 1.0 + 2.5 * col * lane * (1.0 - bub);
  gl_FragColor = vec4(col, 1.0);
}`;

export default flowScene({
  frag: FRAG,
  colors: { uCool: "#e3ecf8", uWarm: "#fff3e2" },
  period: PERIOD,
  backdrop: paint,
  extra: poses,
});
