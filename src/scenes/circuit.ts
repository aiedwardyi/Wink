// Circuit: a dark board seen up close around a processor on the right. The
// board is a still plate; each frame adds light on the board, pulses racing along
// the plate's traces and lit traces round the walls and the composer, so a still
// costs nothing and a frame stays cheap.
import type { SceneApi, SceneModule } from "./scene-host";
import tallUrl from "./plates/circuit-tall.webp";
import wideUrl from "./plates/circuit-wide.webp";

const ROLL_CAP_MS = 30000;
const PERIOD = 600;

// Each plate's size, its chip (centre and package half-size in plate px), where the chip lands (tr px from its right edge to the screen's,
// its centre ty down), a zoom below cover and the bands (left, bottom; in plate sizes) the board folds back over past those edges.
export const PLATES = {
  wide: { url: wideUrl, w: 1536, h: 1024, ax: 1084, ay: 524, cr: 176, tr: 8, ty: 0.45, z: 0.5, fold: [0.5, 0.3] },
  tall: { url: tallUrl, w: 1024, h: 1536, ax: 720, ay: 376, cr: 172, tr: 4, ty: 0.17, z: 0.46, fold: [0.45, 0.6] },
};
type Plate = (typeof PLATES)["wide"];

// Put the chip where the plate says. On an axis the plate covers, pull back so its edge stays off-screen. Left and below, the board
// folds back over bands clear of the chip; above, it mirrors, so the zoom keeps that mirrored chip off-screen.
export function place(p: Plate, width: number, height: number) {
  const s = Math.max(Math.max(width / p.w, height / p.h) * p.z, (height * p.ty) / (2 * p.ay - p.cr));
  const fit = (size: number, plate: number, at: number) => (plate * s >= size ? Math.min(0, Math.max(size - plate * s, at)) : at);
  return { s, ox: fit(width, p.w, width - p.tr - (p.ax + p.cr) * s), oy: fit(height, p.h, height * p.ty - p.ay * s) };
}

const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";
const COMMON = `
float h1(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec4 tex(vec2 u) { return texture2D(uPlate, 1.0 - abs(1.0 - mod(u, 2.0))); }
// Past the left and bottom edges the board folds back over bands clear of the chip, so the chip never repeats.
vec2 fold(vec2 u) {
  vec2 b = vec2(uFold.x * (1.0 - abs(1.0 - mod(-u.x / uFold.x, 2.0))), 1.0 - uFold.y * (1.0 - abs(1.0 - mod((u.y - 1.0) / uFold.y, 2.0))));
  return vec2(u.x < 0.0 ? b.x : u.x, u.y > 1.0 ? b.y : u.y);
}
// A far board behind the plate's dark areas, soft as if out of focus. Each cell edge carries a trace or not, and
// neighbouring cells share that coin, so the traces join up; a dead end ends on a via. k widens the traces.
float farBoard(vec2 q, float k) {
  vec2 c = floor(q), g = q - c - 0.5;
  float d = 9.0, n = 0.0;
  if (h1(c + vec2(0.0, 0.5)) > 0.55) { d = min(d, length(vec2(g.x - clamp(g.x, -0.5, 0.0), g.y))); n += 1.0; }
  if (h1(c + vec2(1.0, 0.5)) > 0.55) { d = min(d, length(vec2(g.x - clamp(g.x, 0.0, 0.5), g.y))); n += 1.0; }
  if (h1(c + vec2(0.5, 0.0)) > 0.55) { d = min(d, length(vec2(g.x, g.y - clamp(g.y, -0.5, 0.0)))); n += 1.0; }
  if (h1(c + vec2(0.5, 1.0)) > 0.55) { d = min(d, length(vec2(g.x, g.y - clamp(g.y, 0.0, 0.5)))); n += 1.0; }
  if (n == 1.0) d = min(d, abs(length(g) - 0.11));
  return exp(-d * d / k);
}`;

// The lit bus from the chip's top pins up to the top wall and down the left one.
const ROUTE = `
vec2 sdl(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return vec2(length(pa - ba * h) * (ba.x * pa.y - ba.y * pa.x < 0.0 ? -1.0 : 1.0), h * length(ba));
}
void walk(vec2 p, vec2 a, vec2 b, inout vec2 best, inout float acc) {
  vec2 v = sdl(p, a, b);
  if (abs(v.x) < abs(best.x)) best = vec2(v.x, acc + v.y);
  acc += length(b - a);
}
// x: signed distance from the middle trace, y: distance along it from the chip.
vec2 wallRoute(vec2 p) {
  float x1 = uChip.x - 3.0, jg = uSize.x > 700.0 ? 12.0 : 0.0;
  float ya = uSize.y * 0.38, yb = uSize.y * 0.62;
  vec2 best = vec2(1e4, 0.0);
  float acc = 0.0;
  walk(p, vec2(x1, uChip.y - uChipR), vec2(x1, 32.5), best, acc);
  walk(p, vec2(x1, 32.5), vec2(x1 - 23.5, 9.0), best, acc);
  walk(p, vec2(x1 - 23.5, 9.0), vec2(42.5, 9.0), best, acc);
  walk(p, vec2(42.5, 9.0), vec2(9.0, 42.5), best, acc);
  walk(p, vec2(9.0, 42.5), vec2(9.0, ya), best, acc);
  walk(p, vec2(9.0, ya), vec2(9.0 + jg, ya + jg), best, acc);
  walk(p, vec2(9.0 + jg, ya + jg), vec2(9.0 + jg, yb), best, acc);
  walk(p, vec2(9.0 + jg, yb), vec2(9.0, yb + jg), best, acc);
  walk(p, vec2(9.0, yb + jg), vec2(9.0, uSize.y + 40.0), best, acc);
  return best;
}`;

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf, uChip, uFold;
uniform float uT, uFlow, uLaneX, uLaneW, uChipR, uCut;
uniform vec4 uBox, uMap;
uniform sampler2D uPlate;
${COMMON}
${ROUTE}
const vec3 LASER = vec3(0.16, 0.52, 1.0);
const vec3 HOT = vec3(0.8, 0.95, 1.0);
const vec3 CYAN = vec3(0.3, 0.85, 1.0);
// A lit trace tr px away, al px along from the chip: dim copper at rest; while working, short packets leave the chip
// 900 px apart and a lead packet runs the whole route every 4.8 s. The wire itself stays near its resting glow.
vec3 lit(float tr, float al, float a0, float run) {
  float ph = uT * 0.367;
  float c = fract(ph - 0.08 * sin(6.2831853 * ph) - al / 900.0) * 900.0;
  float cy = min(c, 900.0 - c);
  float core = 1.0 - smoothstep(0.3, 1.0, tr);
  float head = exp(-cy * cy / 40.0), tail = exp(-c / 65.0);
  float sw = fract(uT * 0.21) * 6000.0 - al;
  float swH = exp(-sw * sw / 300.0), swT = step(0.0, sw) * exp(-sw / 90.0);
  float g1 = exp(-tr / 3.0), g2 = exp(-tr / 11.0);
  // At rest a few soft stretches stay lit (top rail, the wall by the bot list, the composer ring).
  float q = mod(a0 - 300.0, 1200.0) - 600.0;
  float fz = (1.0 - run) * (exp(-q * q / 900.0) + 0.55 * exp(-q * q / 24200.0));
  return (HOT * core * 0.6 + LASER * g1 * 0.5 + LASER * g2 * 0.2) * fz + HOT * core * (0.22 + 0.04 * run) + LASER * (exp(-tr / 2.2) * 0.2 + exp(-tr / 9.0) * 0.08) * (0.8 + 0.2 * run)
    + (HOT * core * (3.0 * head + 1.7 * tail + 2.2 * swH + 1.0 * swT) + LASER * g1 * (1.2 * head + 0.9 * tail + 1.2 * swH + 0.8 * swT)
    + LASER * g2 * (0.45 * head + 0.3 * tail + 0.3 * swT) + mix(LASER, HOT, 0.4) * exp(-cy * cy / 300.0 - tr * tr / 12.0) * 0.9
    + LASER * exp(-cy * cy / 2500.0 - tr * tr / 150.0) * 0.25 + LASER * exp(-sw * sw / 2500.0 - tr * tr / 200.0) * 0.4) * run;
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  float f = uFlow;
  float run = f;
  float R = uChipR;
  // The camera eases in on the chip while working; at rest the plate sits exactly at its fit.
  vec2 pp = uChip + (px - uChip) / (1.0 + 0.03 * f);
  vec2 uv = fold(pp * uMap.xy + uMap.zw);
  vec4 pl = tex(uv);
  vec3 base = pl.rgb;
  vec2 cq = px - uChip;
  vec2 fo = abs(cq);
  float dc = length(cq);
  // The far board drifts less than the plate as the camera eases in, so the two read as depths apart, and it goes out
  // of focus away from the chip; while working, fronts of light sweep across it toward the chip.
  vec2 fq = (px - uChip) / (26.0 * (1.0 + 0.012 * f)) + 0.37;
  float sweep = pow(max(0.0, sin(length(fq) * 0.55 + uT * 2.6)), 10.0) * f * 0.4;
  float bl = smoothstep(R * 1.5, R * 1.5 + uSize.x * 0.7, dc);
  base += vec3(0.09, 0.23, 0.54) * farBoard(fq, 0.0035 + 0.02 * bl) * (1.0 - 0.5 * bl) * (0.55 + 0.45 * sin(fq.x * 0.23 + 1.7 * sin(fq.y * 0.19))) * (0.6 + 2.0 * sweep)
    * (1.0 - smoothstep(0.03, 0.12, dot(base, vec3(0.3, 0.5, 0.2))));
  // A faint blue haze rises off the bottom edge, and the board fades into it away from the chip.
  base += vec3(0.012, 0.035, 0.09) * exp(-(uSize.y - px.y) / (uSize.y * 0.22));
  base = mix(base, vec3(0.02, 0.05, 0.11), 0.3 * bl);
  // Alpha is 0.5 + half the trace mask, so a browser that premultiplies on upload cannot crush the colour.
  float m = clamp(pl.a * 2.0 - 1.0, 0.0, 1.0);
  vec2 o = 3.0 * uMap.xy;
  float mb = clamp((tex(uv + o).a + tex(uv - o).a + tex(uv + vec2(o.x, -o.y)).a + tex(uv - vec2(o.x, -o.y)).a) * 0.5 - 1.0, 0.0, 1.0);
  // A dark band under the header keeps its icons and title off the board's brightest dots.
  float hb = (1.0 - smoothstep(30.0, 90.0, px.y)) * smoothstep(R * 0.8, R * 1.6, dc);
  base *= 1.0 - 0.6 * hb;
  float pool = exp(-dc / (R * 2.5)) + 0.5 * exp(-dc / (R * 8.0));
  // Light pools on the board round the chip, not only on its traces.
  vec3 add = LASER * m * pool * 0.34 + vec3(0.1, 0.35, 0.9) * exp(-dc / (R * 2.2)) * 0.16;

  // Packets run in along the chip's buses (rows to its sides, columns above and below), each trace on its own phase and speed.
  bool side = fo.x > fo.y;
  float along = max(fo.x, fo.y) - R;
  float bus = floor((side ? cq.y : cq.x) / (R * 0.065)) + (side ? (cq.x > 0.0 ? 300.0 : 0.0) : (cq.y > 0.0 ? 900.0 : 600.0));
  float v = 160.0 + 240.0 * h1(vec2(bus, 7.7));
  float c = fract((uT * v + along) / 560.0 + h1(vec2(bus, 1.9))) * 560.0;
  float cy = min(c, 560.0 - c);
  float pin = smoothstep(-R * 0.08, 0.0, along);
  float near = exp(-max(along, 0.0) / (R * 6.0)) * pin;
  float amp = step(0.72, h1(vec2(bus, 3.1))) * (0.9 + 0.9 * h1(vec2(bus, 9.1))) * near;
  float held = step(0.7, h1(vec2(bus, 5.3))) * exp(-max(along, 0.0) / (R * 3.0)) * pin;
  float mt = smoothstep(0.15, 0.55, m);
  // Each beat a square wave of light closes in through the traces to the pins.
  float bt = fract(uT * 1.1);
  float wave = exp(-pow(along - R * 2.6 * (1.0 - bt), 2.0) / (R * R * 0.03)) * bt * f * pin;
  add += mt * (LASER * held * 0.7 + f * CYAN * amp * (exp(-cy * cy / 160.0) * 3.2 + exp(-c / 120.0) * 1.5) + LASER * wave * 1.4)
    + mb * (f * amp * CYAN * (exp(-cy * cy / 600.0) * 1.4 + exp(-c / 140.0) * 0.5) + LASER * wave * 0.5);
  // Dust hangs over the board and rises while working; round the chip it glints like sparks.
  vec2 sq = px / 23.0 + vec2(0.0, uT * 0.4);
  vec2 sc = floor(sq);
  vec2 so = fract(sq) - 0.5 - (vec2(h1(sc + 3.1), h1(sc + 9.7)) - 0.5) * 0.6;
  float spark = step(0.8, h1(sc * 1.3 + 7.0)) * exp(-dot(so, so) * 529.0 / 1.6) * (0.6 + 0.4 * sin(uT * 3.0 + h1(sc) * 40.0));
  add += CYAN * spark * (0.1 + 0.8 * exp(-dc / (R * 2.2)) * (0.3 + 0.7 * f));
  // A few sparks float out of focus in front of the board, and spread past it as the camera eases in.
  vec2 bq = (uChip + (px - uChip) / (1.0 + 0.08 * f)) / 150.0 + vec2(0.0, uT * 0.05);
  vec2 bc = floor(bq);
  float bo = length(fract(bq) - 0.3 - 0.4 * vec2(h1(bc + 5.3), h1(bc + 8.1)));
  float brr = mix(0.05, 0.12, h1(bc + 2.9));
  add += CYAN * step(0.8, h1(bc + 4.4)) * (1.0 - smoothstep(brr * 0.75, brr, bo)) * (0.75 + 0.25 * smoothstep(brr * 0.5, brr * 0.95, bo)) * 0.12 * (0.7 + 0.3 * f);
  // The package is the plate's own: nothing is drawn over it, so its die only shows the light it reflects.
  add *= (1.0 - 0.6 * hb) * smoothstep(R * 0.97, R * 1.04, max(fo.x, fo.y));

  float dx = abs(px.x - uLaneX);
  // The chip itself stays lit: bot text stops short of it, and user bubbles over it are opaque.
  float lane = (1.0 - smoothstep(uLaneW - 55.0, uLaneW + 15.0, dx)) * smoothstep(40.0, 130.0, px.y) * (1.0 - 0.85 * (1.0 - smoothstep(R, R * 1.25, max(fo.x, fo.y))));
  float calm = uBox.z > 0.0 ? smoothstep(uBox.y - 110.0, uBox.y - 40.0, px.y) * (1.0 - smoothstep(uLaneW - 55.0, uLaneW + 15.0, dx)) : 0.0;
  // Under the column the board is dimmed and its highlights squeezed, so grey text keeps its contrast over it.
  float bLum = dot(base, vec3(0.3, 0.5, 0.2));
  float dimB = mix(1.0, 0.5 / (1.0 + bLum * 0.5 / 0.06), lane) * (1.0 - 0.5 * calm);
  float dimA = (1.0 - 0.55 * lane) * (1.0 - calm);

  // Three lit traces run from the chip to the walls and the composer; the outer two are offset 6 px.
  vec3 edge = vec3(0.0);
  float x1 = uChip.x - 3.0;
  float dimR = mix(1.0 - 0.75 * lane, 1.0, 1.0 - smoothstep(30.0, 60.0, min(px.x, px.y))) * smoothstep(R + 8.0, R + 11.0, max(fo.x, fo.y));
  if (px.x < 60.0 || px.y < 45.0 || (abs(px.x - x1) < 30.0 && px.y < uChip.y)) {
    vec2 w = wallRoute(px);
    float t = clamp(floor(w.x / 6.0 + 1.5), 0.0, 2.0);
    // On a phone the header icons sit in the corner, so the route shows only below the header.
    edge += lit(abs(w.x - (t - 1.0) * 6.0), w.y - t * 47.0, w.y, run) * (t == 1.0 ? 1.0 : 0.75) * dimR * (uSize.x > 700.0 ? 1.0 : smoothstep(56.0, 90.0, px.y));
  }
  if (uBox.z > 0.0) {
    float xT = clamp(x1, uBox.x + 40.0, uBox.x + uBox.z - 40.0);
    float dj = abs(x1 - xT);
    float y2 = uBox.y - 43.0, y1 = y2 - dj;
    float ringL = y1 - uChip.y - R + dj * 1.4142 + 36.0;
    if (uSize.x > 700.0 && y1 > uChip.y + R + 30.0 && px.y > uChip.y && px.x > min(x1, xT) - 30.0 && px.x < max(x1, xT) + 30.0) {
      vec2 b = vec2(1e4, 0.0);
      float acc = 0.0;
      walk(px, vec2(x1, uChip.y + R), vec2(x1, y1), b, acc);
      walk(px, vec2(x1, y1), vec2(xT, y2), b, acc);
      walk(px, vec2(xT, y2), vec2(xT, uBox.y + 30.0), b, acc);
      float t = clamp(floor(b.x / 6.0 + 1.5), 0.0, 2.0);
      edge += lit(abs(b.x - (t - 1.0) * 6.0), b.y - t * 47.0, b.y, run) * (t == 1.0 ? 1.0 : 0.75) * dimR;
    }
    // A chamfered ring on the composer's own edge, fed at the top where the bus lands; pulses split both ways round it.
    vec2 hb = uBox.zw * 0.5 + 0.5;
    vec2 rp = px - uBox.xy - uBox.zw * 0.5;
    vec2 ap = abs(rp);
    float rd = abs(max(max(ap.x - hb.x, ap.y - hb.y), (ap.x + ap.y - hb.x - hb.y + uCut) * 0.7071));
    float u = ap.y * hb.x > ap.x * hb.y ? (rp.y < 0.0 ? rp.x + hb.x : 3.0 * hb.x + 2.0 * hb.y - rp.x) : (rp.x > 0.0 ? 2.0 * hb.x + rp.y + hb.y : 4.0 * hb.x + 3.0 * hb.y - rp.y);
    float P = 4.0 * (hb.x + hb.y);
    float uu = mod(u - (xT - uBox.x - uBox.z * 0.5 + hb.x), P);
    if (rd < 120.0) edge += lit(rd, ringL + min(uu, P - uu), ringL + min(uu, P - uu), run) * 0.65;
  }

  vec3 col = base * dimB;
  col += (1.0 - col) * (1.0 - exp(-(add * dimA + edge)));
  col += (h1(gl_FragCoord.xy + fract(uT * 7.31) * 413.0) - 0.5) * 0.016;
  gl_FragColor = vec4(col, 1.0);
}`;

const FRAME_UNIFORMS = ["uSize", "uBuf", "uChip", "uChipR", "uCut", "uFold", "uT", "uFlow", "uLaneX", "uLaneW", "uBox", "uMap", "uPlate"] as const;

function create(api: SceneApi) {
  const canvas = document.createElement("canvas");
  api.layer.append(canvas);
  const main = api.layer.parentElement;
  let width = 0;
  let height = 0;
  let clock = 0;
  let flow = 0;
  let flowTarget = 0;
  let settleAt = -1;
  let capAt = Infinity;

  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
  // SAFETY: the loop below fills every name once the program links, and render() only draws after it did.
  const U = {} as Record<(typeof FRAME_UNIFORMS)[number], WebGLUniformLocation | null>;
  let frameProg: WebGLProgram | null = null;
  const plate = gl?.createTexture() ?? null;
  let shown: Plate | null = null;
  let wanted: Plate | null = null;
  let ready = false;
  // By the window, not the layer: theme tiles are landscape on phones too, so each device loads one plate.
  const load = () => {
    const p = innerWidth > innerHeight ? PLATES.wide : PLATES.tall;
    if (!gl || wanted === p) return;
    wanted = p;
    const img = new Image();
    img.src = p.url;
    // Decoded off the main thread while the shader compiles; an onload image would decode inside texImage2D, on the pick's first frame.
    void img.decode().catch(() => undefined).then(() => {
      if (!ready || wanted !== p || !img.naturalWidth) return;
      gl.bindTexture(gl.TEXTURE_2D, plate);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      shown = p;
      render();
    });
  };
  load();
  if (gl) {
    const program = (frag: string) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]] as const) {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        gl.attachShader(p, s);
      }
      gl.bindAttribLocation(p, 0, "a");
      gl.linkProgram(p);
      return [p, !!gl.getProgramParameter(p, gl.LINK_STATUS)] as const;
    };
    const [fp, frameOk] = program(FRAG);
    if (frameOk) {
      frameProg = fp;
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      for (const name of FRAME_UNIFORMS) U[name] = gl.getUniformLocation(fp, name);
      gl.bindTexture(gl.TEXTURE_2D, plate);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
      ready = true;
    }
  }
  if (!ready) api.layer.style.background = "linear-gradient(180deg, var(--color-app), var(--color-panel))";

  // The composer's corners are cut where the browser can (styles.css); the ring follows either shape's edge.
  const cut = globalThis.CSS?.supports?.("corner-shape", "bevel") ? 24 : 14;

  const render = () => {
    if (!gl || !ready || !shown || !width) return;
    const p = shown;
    const { s, ox, oy } = place(p, width, height);
    gl.useProgram(frameProg);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uSize, width, height);
    gl.uniform2f(U.uBuf, canvas.width, canvas.height);
    gl.uniform1f(U.uT, clock);
    gl.uniform1f(U.uFlow, flow);
    // The board dims under the transcript so timestamps and actions stay readable over it.
    const col = main?.querySelector("[data-orbit-transcript] > div");
    const lane = col ? api.rectIn(col) : { cx: -1e5, w: 0 };
    gl.uniform1f(U.uLaneX, lane.cx);
    gl.uniform1f(U.uLaneW, lane.w / 2 + 40);
    const box = main?.querySelector("[data-orbit-composer-frame]");
    const b = box ? api.rectIn(box) : { x: 0, y: 0, w: 0, h: 0 };
    gl.uniform4f(U.uBox, b.x, b.y, b.w, b.h);
    gl.uniform4f(U.uMap, 1 / (s * p.w), 1 / (s * p.h), -ox / (s * p.w), -oy / (s * p.h));
    gl.uniform2f(U.uChip, ox + p.ax * s, oy + p.ay * s);
    gl.uniform1f(U.uChipR, p.cr * s);
    gl.uniform1f(U.uCut, cut);
    gl.uniform2f(U.uFold, p.fold[0], p.fold[1]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, plate);
    gl.uniform1i(U.uPlate, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Traces are a pixel wide, so the buffer follows the screen's density. Layout size: a theme tile shrinks its layer with a transform.
  const resize = () => {
    const dpr = Math.min(3, devicePixelRatio || 1);
    width = Math.max(1, api.layer.clientWidth);
    height = Math.max(1, api.layer.clientHeight);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    load();
    render();
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(api.layer);

  const roll = (settle: number) => {
    flowTarget = 1;
    settleAt = settle;
    api.wake();
  };

  return {
    frame(t: number, dt: number) {
      const k = dt / 1000;
      if ((settleAt >= 0 && t >= settleAt) || t >= capAt) {
        flowTarget = 0;
        settleAt = -1;
        capAt = Infinity;
      }
      flow += (flowTarget - flow) * (1 - Math.exp(-k / (flowTarget > flow ? 0.35 : 0.9)));
      if (flowTarget === 0 && flow < 0.02) flow = 0;
      clock = (clock + k * flow) % PERIOD;
      render();
      return flowTarget > 0 || flow > 0;
    },
    event(event) {
      if (!ready) return;
      if (event.name === "skin" || event.name === "motion") return render();
      if (api.reduced()) return;
      if (event.name === "loop") {
        capAt = Infinity;
        roll(-1);
      }
      // A send mid-turn must not end the turn's own roll.
      if (event.name === "send" && (flowTarget === 0 || settleAt >= 0)) roll(api.time() + 2600);
      if (event.name === "busy") {
        capAt = api.time() + ROLL_CAP_MS;
        roll(-1);
      }
      if (event.name === "reply") roll(api.time() + 1400);
    },
    dispose() {
      sizes.disconnect();
      wanted = null;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      api.layer.style.background = "";
    },
  } satisfies ReturnType<SceneModule["create"]>;
}

// A turn can run for minutes, so it also rests while the window is in the background.
const circuit: SceneModule = { pauseOnBlur: true, create };
export default circuit;
