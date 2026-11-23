// Night Rain: a Seoul alley of pojangmacha tents under neon, in the rain. The alley is a
// painted plate drawn once per size; a passer-by under a clear umbrella walks
// away down it from a four-frame strip, lit by the lanterns he passes. The
// shader adds the rain, ripples, splashes, the shimmer of the wet street, his
// reflection, haze, steam and drips, and a sign that buzzes while Wink works.
import { flowScene } from "./flow";
import tallUrl from "./plates/night-rain-alley-tall.webp";
import wideUrl from "./plates/night-rain-alley-wide.webp";
import walkUrl from "./plates/night-rain-walk.webp";

const PERIOD = 60;

// Each alley plate in its own pixels: size, the street's vanishing point and depth scale (fractions), where on screen the vanishing point goes, where its floor meets the walls at the bottom edge, a sign that buzzes, a vent that steams, how far right of the street's middle he walks (m), and plate px rects put out (a sign moved off them).
const ALLEYS = {
  wide: { w: 1536, h: 1024, vp: [0.513, 0.561], k: 0.2, aim: 0.52, floor: [-0.06, 0.85], sign: [0.758, 0.027, 0.806, 0.317], vent: [0.869, 0.64], side: 0.6, dark: [] },
  tall: { w: 1024, h: 1536, vp: [0.576, 0.586], k: 0.2, aim: 0.41, floor: [-1.0, 0.9], sign: [0.859, 0.251, 0.909, 0.417], vent: [0.825, 0.624], side: 0.2, dark: [] },
};
type Sign = [number, number, number, number, string, string, string, number];
// The plates' signs are blank panels, so each is repainted as a lit box with a real word: its rect in plate px, its glow, its core, the word top to bottom, and how hot it burns.
const SIGNS = {
  wide: [
    [1164, 28, 1237, 325, "#ff4fb8", "#ffe0f2", "포장마차", 1],
    [1064, 142, 1114, 381, "#2fd3ff", "#d8f8ff", "노래방", 1],
    [997, 259, 1032, 432, "#f25ae6", "#ffe3fb", "소주", 1],
    [954, 334, 985, 464, "#b36eff", "#efe3ff", "호프", 1],
    [905, 404, 925, 496, "#2fd3ff", "#d8f8ff", "영업중", 1],
  ],
  tall: [
    [886, 35, 931, 336, "#ff2fa8", "#ffe0f2", "포장마차", 1],
    [784, 243, 822, 490, "#2fd3ff", "#d8f8ff", "노래방", 1],
    [705, 371, 737, 599, "#ff70b8", "#ffe6f3", "소주", 1],
    [778, 528, 815, 721, "#ff2fc0", "#ffe0f6", "치킨", 1],
    [880, 385, 931, 640, "#ff3048", "#ffe4e8", "영업중", 1],
  ],
} satisfies Record<"wide" | "tall", Sign[]>;
const KO = (px: number) => `700 ${px}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR", sans-serif`;
// Without a Korean font the words would draw as empty boxes: the plate keeps its own signs then.
function hasKorean() {
  const c = document.createElement("canvas");
  c.width = c.height = 24;
  const s = c.getContext("2d", { willReadFrequently: true })!;
  s.font = KO(20);
  const ink = (ch: string) => {
    s.clearRect(0, 0, 24, 24);
    s.fillText(ch, 2, 20);
    return s.getImageData(0, 0, 24, 24).data.join();
  };
  return ink("한") !== ink(String.fromCodePoint(0x10fffd));
}

// One cell of the walk strip in its own pixels: size, his heel line, his centre, and his umbrella's rim ends, where drips fall from.
const WALK = { w: 440, h: 772, heel: 765, cx: 190, rim: [[12, 130], [368, 135]] };

// The backdrop paints synchronously, so the plates are decoded before this module resolves; only WebGL can show them.
const decode = (url: string) =>
  fetch(url)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .catch(() => null);
const [wide, tall, walk] = "WebGLRenderingContext" in globalThis ? await Promise.all([wideUrl, tallUrl, walkUrl].map(decode)) : [null, null, null];

// Whether a screen px is on one of the plate's sign panels.
const lit = (k: "wide" | "tall") => SIGNS[k].map(([x0, y0, x1, y1]) => `inBox(s, px, vec4(${[x0 / ALLEYS[k].w, y0 / ALLEYS[k].h, x1 / ALLEYS[k].w, y1 / ALLEYS[k].h].map((v) => v.toFixed(4)).join(", ")}))`).join(" + ");
const pick = (vec: string, f: (p: (typeof ALLEYS)["wide"]) => number[]) => `s.x < s.y ? ${vec}(${f(ALLEYS.tall).join(", ")}) : ${vec}(${f(ALLEYS.wide).join(", ")})`;

// Shared with the shader: the plate's cover fit, anchored on its bottom right.
const LAYOUT = `
vec2 plateSize(vec2 s) { return ${pick("vec2", (p) => [p.w, p.h])}; }
vec3 plateVp(vec2 s) { return ${pick("vec3", (p) => [...p.vp, p.k])}; }
float plateAim(vec2 s) { return s.x < s.y ? ${ALLEYS.tall.aim} : ${ALLEYS.wide.aim}; }
vec2 plateFloor(vec2 s) { return ${pick("vec2", (p) => p.floor)}; }
vec4 plateSign(vec2 s) { return ${pick("vec4", (p) => p.sign)}; }
vec2 plateVent(vec2 s) { return ${pick("vec2", (p) => p.vent)}; }
// Covering the screen, scaled up if need be so the vanishing point lands on its aim: scale, then the plate's top left.
vec3 fit(vec2 s) {
  vec2 p = plateSize(s);
  float v = plateVp(s).x, aim = plateAim(s);
  float c = max(max(s.x / p.x, s.y / p.y), max(aim * s.x / (v * p.x), (1.0 - aim) * s.x / ((1.0 - v) * p.x)));
  return vec3(c, aim * s.x - v * p.x * c, s.y - p.y * c);
}
vec2 onPlate(vec2 s, vec2 f) { vec3 k = fit(s); return k.yz + f * plateSize(s) * k.x; }
float inBox(vec2 s, vec2 px, vec4 r) { vec2 a = onPlate(s, r.xy), b = onPlate(s, r.zw); return step(a.x, px.x) * step(px.x, b.x) * step(a.y, px.y) * step(px.y, b.y); }
float plateLit(vec2 s, vec2 px) { return s.x < s.y ? ${lit("tall")} : ${lit("wide")}; }
// Three walks away down the street a loop, from the right edge into the haze: his heels, his height to the umbrella's tip (2.05 m, so 0.78 of it is the 1.6 m eye line), and what the haze leaves of him.
vec4 walker(vec2 s, vec2 vp, float t) {
  float p = fract(t * 3.0 / ${PERIOD}.0 + 0.17);
  float h = (s.x < s.y ? 0.3 : 0.5) * s.y / (1.0 + 3.0 * p);
  return vec4(vp.x + h * (s.x < s.y ? ${ALLEYS.tall.side / 2.05} : ${ALLEYS.wide.side / 2.05}), vp.y + 0.78 * h, h, 1.0 - smoothstep(0.75, 1.0, p));
}`;
const FAR = 0.075;

type Ctx = CanvasRenderingContext2D;

function paint(g: Ctx, w: number, h: number) {
  const p = w < h ? tall : wide;
  const P = w < h ? ALLEYS.tall : ALLEYS.wide;
  g.fillStyle = "#04030a";
  g.fillRect(0, 0, w, h);
  if (p) {
    const v = P.vp[0];
    const c = Math.max(w / P.w, h / P.h, (P.aim * w) / (v * P.w), ((1 - P.aim) * w) / ((1 - v) * P.w));
    const ox = P.aim * w - v * P.w * c;
    const oy = h - P.h * c;
    g.drawImage(p, ox, oy, P.w * c, P.h * c);
    for (let i = 0; i < P.dark.length; i += 4) {
      const [x0, y0, x1, y1] = P.dark.slice(i, i + 4);
      g.save();
      g.fillStyle = "#05030a";
      g.shadowColor = "#05030a";
      g.shadowBlur = 30 * c;
      g.globalAlpha = 0.9;
      g.fillRect(ox + x0 * c, oy + y0 * c, (x1 - x0) * c, (y1 - y0) * c);
      g.restore();
    }
    if (hasKorean()) {
      // Drawn on their own sheet and softened onto the plate, so they sit in its paint rather than on it.
      const sheet = document.createElement("canvas");
      sheet.width = g.canvas.width;
      sheet.height = g.canvas.height;
      const dpr = g.canvas.width / w;
      const s = sheet.getContext("2d")!;
      s.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [x0, y0, x1, y1, glow, core, word, hot] of SIGNS[w < h ? "tall" : "wide"]) {
        const x = ox + x0 * c;
        const y = oy + y0 * c;
        const bw = (x1 - x0) * c;
        const bh = (y1 - y0) * c;
        // Its light on the wall around it.
        g.save();
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = 0.3 * hot;
        g.shadowColor = glow;
        g.shadowBlur = 60 * c;
        g.fillStyle = glow;
        g.fillRect(x, y, bw, bh);
        g.restore();
        s.save();
        // Dark glass, washed by its own tubes.
        s.fillStyle = "#08050d";
        s.fillRect(x, y, bw, bh);
        s.globalAlpha = 0.16 * hot;
        s.fillStyle = glow;
        s.fillRect(x, y, bw, bh);
        s.globalAlpha = 0.3 + 0.7 * hot;
        s.shadowColor = glow;
        for (const [lw, blur, color] of [[2.6, 16, glow], [1, 4, core]] as const) {
          s.strokeStyle = color;
          s.lineWidth = lw * c;
          s.shadowBlur = blur * c;
          s.strokeRect(x + 3 * c, y + 3 * c, bw - 6 * c, bh - 6 * c);
        }
        const chars = [...word];
        const size = Math.min(bw * 0.7, (bh * 0.84) / chars.length);
        s.font = KO(size);
        s.textAlign = "center";
        s.textBaseline = "middle";
        chars.forEach((ch, i) => {
          const cy = y + bh / 2 + (i - (chars.length - 1) / 2) * size * 1.06;
          for (const [blur, color] of [[24, glow], [8, glow], [2, glow]] as const) {
            s.fillStyle = color;
            s.shadowBlur = blur * c;
            s.fillText(ch, x + bw / 2, cy);
          }
        });
        s.restore();
      }
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.filter = `blur(${0.4 * dpr}px)`;
      g.drawImage(sheet, 0, 0);
      g.restore();
    }
  }
}

// The walk strip, scaled once per size to about his height mid-walk: red his coverage, green his tone premultiplied by it.
function strip(_w: number, h: number, dpr: number) {
  if (!walk) return null;
  const k = Math.min(1, (0.3 * h * dpr) / WALK.h);
  const c = document.createElement("canvas");
  c.width = Math.round(walk.width * k);
  c.height = Math.round(walk.height * k);
  const s = c.getContext("2d", { willReadFrequently: true })!;
  s.imageSmoothingQuality = "high";
  s.drawImage(walk, 0, 0, c.width, c.height);
  const out = s.getImageData(0, 0, c.width, c.height);
  const o = out.data;
  for (let i = 0; i < o.length; i += 4) {
    const a = o[i + 3];
    o[i + 1] = (o[i] * a) / 255;
    o[i] = a;
    o[i + 2] = 0;
    o[i + 3] = 255;
  }
  return out;
}

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uT, uFlow, uLaneX, uLaneW;
uniform sampler2D uTex, uTex2;
uniform vec3 uRain, uHaze, uWarm;
${LAYOUT}
const float TAU = 6.2831853;
const float W = TAU / ${PERIOD}.0;
const float FAR = ${FAR};
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float n2(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, per), x1 = mod(i.x + 1.0, per);
  float y0 = mod(i.y, per), y1 = mod(i.y + 1.0, per);
  return mix(mix(h12(vec2(x0, y0)), h12(vec2(x1, y0)), f.x), mix(h12(vec2(x0, y1)), h12(vec2(x1, y1)), f.x), f.y);
}
vec4 tex4(vec2 p) { return texture2D(uTex, clamp(p / uSize, 0.0, 1.0)); }
vec3 tex(vec2 p) { return tex4(p).rgb; }
// His coverage and tone at a point in strip cell px, in walk frame fr.
vec2 him4(vec2 c, float fr) {
  if (c.x < 0.0 || c.x > ${WALK.w}.0 || c.y < 0.0 || c.y > ${WALK.h}.0) return vec2(0.0);
  return texture2D(uTex2, vec2((c.x + fr * ${WALK.w}.0) / ${WALK.w * 4}.0, c.y / ${WALK.h}.0)).rg;
}
// A lantern close to the lens, out of focus: a soft disc, a little brighter toward its rim.
vec3 bokeh(vec2 px, vec2 c, float r, vec3 hue) {
  float d = length(px - c) / r;
  return hue * (1.0 - smoothstep(0.8, 1.0, d)) * (0.7 + 0.3 * smoothstep(0.45, 0.95, d));
}
// One depth of rain: streaks in slanted columns cw px apart, len px long, falling n cells a loop.
float rain(vec2 px, float cw, float len, float n, float thick, float seed, float slant) {
  vec2 p = vec2(px.x + px.y * slant, px.y);
  float c = floor(p.x / cw);
  float hc = h12(vec2(c, seed));
  float y = p.y / len - uT * n / ${PERIOD}.0 + hc * 37.0;
  float cell = floor(y);
  float hr = h12(vec2(c, mod(cell, n) + seed * 7.0));
  if (hr < 0.55 - 0.15 * uFlow) return 0.0;
  float fy = fract(y);
  float x = abs(fract(p.x / cw) - 0.2 - 0.6 * hr) * cw;
  float lk = fract(hr * 13.7);
  float tail = 0.1 + 0.55 * lk * lk;
  float streak = smoothstep(0.0, 0.12, fy) * (1.0 - smoothstep(tail, tail + 0.1 + 0.3 * lk, fy));
  return streak * (1.0 - smoothstep(thick * 0.3, thick, x)) * (0.25 + 0.75 * hr * hr);
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  vec2 uv = px / uSize;
  vec3 pv = plateVp(uSize);
  vec2 vp = onPlate(uSize, pv.xy);
  float K = pv.z * plateSize(uSize).y * fit(uSize).x;
  float t = uT;
  // He walks a step every half second, rising a little as each leg passes.
  vec4 wk = walker(uSize, vp, t);
  float ws = wk.z / ${WALK.heel - 5}.0;
  float wf = floor(fract(t) * 4.0);
  vec2 wq = (px - wk.xy) / ws + vec2(${WALK.cx}.0, ${WALK.heel}.0 + 5.0 * mod(wf, 2.0));
  vec2 H = him4(wq, wf) * wk.w;
  float him = H.x;
  // The street under this row: its depth, and where on it this pixel is in metres.
  float l = max((px.y - vp.y) / (1.6 * K), 0.02);
  vec2 pf = plateFloor(uSize);
  vec2 fl = onPlate(uSize, vec2(pf.x, 1.0)), fr = onPlate(uSize, vec2(pf.y, 1.0));
  float dy = max(px.y - vp.y, 0.001);
  float inside = step(vp.x + (fl.x - vp.x) * dy / (fl.y - vp.y), px.x) * step(px.x, vp.x + (fr.x - vp.x) * dy / (fr.y - vp.y));
  float onFloor = step(vp.y + 1.6 * K * FAR, px.y) * inside * (1.0 - him);
  vec2 m = vec2((px.x - vp.x) / (K * l), 6.0 / l);
  vec2 look = px;
  float ring = 0.0;
  float splash = 0.0;
  if (onFloor > 0.0) {
    // Drops land in 45 cm cells, more of them under the lights; each ring grows to 16 cm, measured in screen px so it stays a fine line.
    vec2 cell = floor(m / 0.45);
    vec2 key = mod(cell, 64.0);
    float hs = h12(key + 0.5);
    float age = fract(hs * 7.0 + t * floor(40.0 + 30.0 * h12(key + 2.0)) / ${PERIOD}.0);
    vec2 q = m - (cell + 0.2 + 0.6 * vec2(h12(key + 4.1), h12(key + 7.3))) * 0.45;
    vec2 mpp = vec2(1.0 / (K * l), 6.0 / (1.6 * K * l * l));
    vec2 qp = q / mpp;
    float big = h12(key + 6.6);
    vec2 rr = max(vec2(age * (0.07 + 0.13 * big)) / mpp, vec2(0.5));
    float e = length(qp / rr);
    float dpx = length(qp) * abs(1.0 - 1.0 / max(e, 0.001));
    vec3 here = tex(px);
    float bright = dot(here, vec3(0.3, 0.5, 0.2));
    float live = step(0.55 - 0.4 * smoothstep(0.08, 0.4, bright), hs) * smoothstep(FAR * 1.5, FAR * 3.0, l);
    float th = 1.1 + 2.0 * age;
    float fade = (1.0 - age) * (1.0 - age) * live;
    ring = (1.0 - smoothstep(th * 0.4, th * 1.5, dpx)) * fade;
    if (big > 0.6 && age > 0.15) {
      vec2 r2 = max(vec2((age - 0.15) * (0.05 + 0.1 * big)) / mpp, vec2(0.5));
      float d2 = length(qp) * abs(1.0 - 1.0 / max(length(qp / r2), 0.001));
      ring += (1.0 - smoothstep(th * 0.4, th * 1.5, d2)) * fade * 0.6;
    }
    splash = exp(-dot(qp, qp) / 3.0) * (1.0 - smoothstep(0.0, 0.1, age)) * live;
    // Uneven jitter, not a wave: a sine here bends fine reflections into a regular squiggle.
    float rough = n2(vec2(m.x * 2.0, m.y * 5.0 + t * 64.0 / ${PERIOD}.0), 64.0) - 0.5;
    float fine = n2(vec2(m.x * 6.0 + 17.0, m.y * 21.0 - t * 128.0 / ${PERIOD}.0), 128.0) - 0.5;
    look.x += (rough * 2.6 + fine * 1.2 + ring * 3.0) * min(l, 1.2) * (0.3 + 1.2 * uFlow);
  }
  vec3 col = tex(look);
  // His reflection in the wet street, broken by the same ripples: a shadow through the neon, his rim a faint smear.
  float ry = px.y - wk.y;
  vec3 lite = tex(vec2(wk.x + wk.z * 0.2 * sign(px.x - wk.x), wk.y - wk.z * 0.95));
  if (ry > 0.0 && ry < 0.5 * wk.z) {
    vec2 R = him4(vec2((look.x - wk.x) / ws + ${WALK.cx}.0, ${WALK.heel}.0 - ry / ws), wf) * wk.w * (1.0 - ry / (0.5 * wk.z));
    col = mix(col, col * 0.2 + lite * (R.y / max(R.x, 0.01)) * 1.5, R.x * 0.8);
  }
  // Him: near black, his umbrella and the edges facing a light lit in its colour by the lanterns and signs on each side of him.
  if (H.x > 0.003) {
    float tn = H.y / H.x;
    vec3 la = tex(vec2(wk.x - wk.z * 0.4, wk.y - wk.z * 0.7)), ra = tex(vec2(wk.x + wk.z * 0.4, wk.y - wk.z * 0.7));
    col = mix(col, mix(vec3(0.012, 0.01, 0.022) + col * 0.1 + (la + ra) * 0.05, lite * 2.6 + 0.04, smoothstep(0.12, 0.85, tn)), H.x);
    float hl = 0.5 * (him4(wq - vec2(4.0, 0.0), wf).x + him4(wq - vec2(10.0, 0.0), wf).x) * wk.w;
    float hr = 0.5 * (him4(wq + vec2(4.0, 0.0), wf).x + him4(wq + vec2(10.0, 0.0), wf).x) * wk.w;
    vec3 lum = vec3(0.3, 0.5, 0.2);
    col += (la * smoothstep(0.2, 0.6, dot(la, lum)) * max(H.x - hl, 0.0) + ra * smoothstep(0.2, 0.6, dot(ra, lum)) * max(H.x - hr, 0.0)) * 1.8 * (1.0 - 0.8 * smoothstep(${(WALK.heel * 0.4).toFixed(1)}, ${(WALK.heel * 0.8).toFixed(1)}, wq.y));
  }
  // The chat column, easing out at its edges so the dim leaves no seam.
  float lx = px.x - uLaneX + uLaneW;
  float lane = smoothstep(-100.0, 40.0, lx) * (1.0 - smoothstep(2.0 * uLaneW - 150.0, 2.0 * uLaneW - 40.0, lx));
  // The sign buzzes: two quick drops every few seconds while Wink works.
  vec4 ps = plateSign(uSize);
  vec2 s0 = onPlate(uSize, ps.xy), s1 = onPlate(uSize, ps.zw);
  float bz = mod(t, 6.0);
  float off = (step(1.0, bz) * step(bz, 1.12) + step(1.25, bz) * step(bz, 1.32) + step(1.5, bz) * step(bz, 1.9) * 0.5) * uFlow;
  float inSign = step(s0.x, px.x) * step(px.x, s1.x) * step(s0.y, px.y) * step(px.y, s1.y);
  float inRefl = step(s0.x - 12.0, px.x) * step(px.x, s1.x + 12.0) * step(vp.y, px.y);
  col *= 1.0 - 0.6 * off * (inSign + 0.6 * inRefl) * smoothstep(0.2, 0.6, dot(col, vec3(0.33)));
  // Drifting haze, thicker toward the far end.
  float fogN = n2(vec2((px.x + t * uSize.y * 0.4 * 8.0 / ${PERIOD}.0) / (uSize.y * 0.4), px.y / (uSize.y * 0.18)), 8.0);
  float deep = exp(-length((px - vp) * vec2(0.7, 1.4)) / (uSize.y * 0.3));
  col += uHaze * fogN * (0.02 + 0.12 * deep);
  // Lanterns close to the lens, out of focus, in the bottom right corner and over the far street.
  vec3 pink = vec3(1.0, 0.25, 0.62), amber = vec3(1.0, 0.5, 0.18), cyan = vec3(0.2, 0.78, 1.0);
  float bh = uSize.y;
  col += bokeh(px, vec2(0.975 * uSize.x, 0.88 * bh), 0.08 * bh, pink) * 0.2 + bokeh(px, vec2(0.92 * uSize.x, 0.97 * bh), 0.045 * bh, amber) * 0.2;
  col += bokeh(px, vp + vec2(-0.06, -0.13) * bh, 0.022 * bh, amber) * 0.22 + bokeh(px, vp + vec2(0.09, -0.21) * bh, 0.03 * bh, pink) * 0.18 + bokeh(px, vp + vec2(-0.13, 0.04) * bh, 0.018 * bh, cyan) * 0.16;
  // Steam from a vent, lit by the doorway under it.
  vec2 sv = onPlate(uSize, plateVent(uSize));
  float sk = K * 0.6;
  vec2 sq = (px - sv) / sk;
  if (sq.y < 0.3 && sq.y > -3.0 && abs(sq.x - sq.y * 0.3) < 1.4) {
    float st = n2(vec2(sq.x * 2.2 - sq.y * 0.6, sq.y * 1.6 + t * 32.0 / ${PERIOD}.0) + 3.0, 16.0);
    st = smoothstep(0.45, 0.85, st) * smoothstep(-3.0, -0.6, sq.y) * (1.0 - smoothstep(-0.2, 0.3, sq.y)) * (1.0 - smoothstep(0.6, 1.4, abs(sq.x - sq.y * 0.3)));
    col += uWarm * st * 0.2 * (1.0 - him);
  }
  // Rain in three depths and a soft near one, lit by whatever glows behind it.
  float near = rain(px, 37.0, 210.0, 600.0, 4.6, 1.0, 0.24);
  float mid = rain(px, 13.0, 80.0, 900.0, 1.3, 2.0, 0.17);
  float far = rain(px, 6.0, 34.0, 1200.0, 0.7, 3.0, 0.12);
  float soft = rain(px, 113.0, 520.0, 300.0, 14.0, 4.0, 0.28);
  float drops = near * 0.75 + mid * 0.45 + far * 0.24 + soft * 0.6;
  if (drops > 0.002) {
    float o = uSize.y * 0.04;
    vec3 glowN = (tex(px + vec2(o, 0.0)) + tex(px - vec2(o, 0.0)) + tex(px + vec2(0.0, o)) + tex(px - vec2(0.0, o))) * 0.25;
    col += (uRain * 0.1 + col * 0.7 + glowN * 4.0) * drops * (0.5 + 0.5 * uFlow) * (1.0 - 0.35 * lane);
  }
  // Ripples and splashes catch the light of the street they land on.
  col += ((col * 3.0 + uRain * 0.22) * ring + (uRain * 0.6 + col * 1.5) * splash) * (0.4 + 0.9 * uFlow);
  // Drips off his umbrella's rim, to the street at his heels.
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 d0 = wk.xy + ((fi < 0.5 ? vec2(${WALK.rim[0][0]}.0, ${WALK.rim[0][1]}.0) : vec2(${WALK.rim[1][0]}.0, ${WALK.rim[1][1]}.0)) - vec2(${WALK.cx}.0, ${WALK.heel}.0)) * ws;
    float yEnd = wk.y + 0.02 * wk.z;
    float dph = fract(t * floor(22.0 + fi * 7.0) / ${PERIOD}.0 + fi * 0.37);
    float fall = smoothstep(0.55, 1.0, dph);
    float dy2 = d0.y + fall * fall * (yEnd - d0.y);
    float bead = smoothstep(0.1, 0.55, dph) * (1.0 - fall);
    vec2 dq = vec2(px.x - d0.x, px.y - dy2);
    float len = 1.0 + fall * 0.06 * wk.z;
    float drop = exp(-dq.x * dq.x / 2.2) * exp(-max(0.0, -dq.y) / len - max(0.0, dq.y) * 0.8) * step(0.55, dph);
    drop += exp(-dot(dq, dq) / 5.0) * bead;
    col += (uRain * 0.5 + tex(vec2(d0.x, dy2)) * 1.5) * drop * 0.9 * wk.w;
  }
  // A splash at each heel as it lands.
  float stp = fract(t * 2.0);
  vec2 hq = (px - vec2(wk.x + (mod(floor(t * 2.0), 2.0) - 0.5) * 0.1 * wk.z, wk.y)) / (wk.z * vec2(0.08, 0.022));
  col += (uRain * 0.3 + lite * 0.8) * (1.0 - smoothstep(0.0, 0.14, abs(length(hq) - 0.3 - 0.9 * stp))) * (1.0 - stp) * (1.0 - stp) * wk.w * 0.8;
  vec2 vq = (uv - vec2(0.55, 0.5)) * vec2(uSize.x / uSize.y, 1.0);
  col *= 1.0 - 0.22 * smoothstep(0.4, 1.3, length(vq));
  col = max(col - 0.012, 0.0) * 1.012;
  col = mix(col, smoothstep(0.0, 1.0, col), 0.3);
  col += (h12(gl_FragCoord.xy + fract(t * 7.0) * 311.0) - 0.5) * 0.024;
  // Under the transcript: dimmed, and its brights held down so text keeps its contrast; he and the signs keep a little of their light.
  lane *= (1.0 - 0.4 * him) * (1.0 - 0.7 * plateLit(uSize, px));
  col *= mix(1.0, uSize.x > uSize.y ? 0.5 : 0.6, lane);
  col /= 1.0 + 2.4 * dot(col, vec3(0.3, 0.5, 0.2)) * lane;
  col *= 1.0 - 0.6 * (1.0 - smoothstep(20.0, 120.0, px.y));
  // On a phone the newest message lands just above the composer: keep the puddle glare down there.
  if (uSize.x < uSize.y) col *= 1.0 - 0.7 * smoothstep(0.58 * uSize.y, 0.8 * uSize.y, px.y);
  gl_FragColor = vec4(col, 1.0);
}`;

export default flowScene({
  frag: FRAG,
  colors: { uRain: "#9fb4e6", uHaze: "#6a3a8a", uWarm: "#ffb98a" },
  period: PERIOD,
  backdrop: paint,
  extra: strip,
});
