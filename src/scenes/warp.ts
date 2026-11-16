// Warp: a nebula round a bright star, and the stars the ship streams past. The
// nebula is a still plate; each frame adds the streaks, which pour out of the
// star the ship flies at, so a still costs nothing and a frame stays
// cheap. Moves while Wink works, glides to a still on reply.
import type { SceneApi, SceneModule } from "./scene-host";
import tallUrl from "./plates/warp-tall.webp";
import wideUrl from "./plates/warp-wide.webp";

const ROLL_CAP_MS = 30000;
const PERIOD = 600;

// Each plate's size, its star in plate px and where the star lands: tr px in from the right, ty down.
const PLATES = {
  wide: { url: wideUrl, w: 1536, h: 1024, ax: 1271, ay: 220, tr: 56, ty: 0.14 },
  tall: { url: tallUrl, w: 1024, h: 1536, ax: 874, ay: 370, tr: 39, ty: 0.3 },
};
type Plate = (typeof PLATES)["wide"];

const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";
const HASH = `
float h1(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 h2(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }`;

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf, uF;
uniform float uT, uFlow, uLaneX, uLaneW;
uniform vec4 uBox, uMap;
uniform sampler2D uPlate;
${HASH}
vec3 sky(vec2 p) { return texture2D(uPlate, p * uMap.xy + uMap.zw).rgb; }
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  float f = uFlow;
  float S = max(uSize.x, uSize.y);
  vec2 d = px - uF;
  float r = length(d) + 0.001;
  // The camera pushes in along the flight and the nebula smears away from the star; at rest the plate sits exactly at its fit.
  vec2 pp = uF + d / (1.0 + 0.05 * f);
  // While working the star breathes every 2.5 s: it draws light in (streak heads pulled toward it, the star dims), swells
  // brighter and wider, then settles. Both terms ease and scale with the flow, so a still never moves.
  float bp = fract(uT * 0.4);
  float inh = smoothstep(0.0, 0.45, bp) * (1.0 - smoothstep(0.45, 0.6, bp)) * f;
  float gro = smoothstep(0.45, 0.62, bp) * (1.0 - smoothstep(0.62, 1.0, bp)) * f;
  vec3 bg = sky(pp);
  if (f > 0.004) {
    // A short smear, gone toward the screen edges so the nebula there holds still.
    float rim = smoothstep(0.0, 90.0, min(min(px.x, uSize.x - px.x), min(px.y, uSize.y - px.y)));
    // Taps stay under 1.5 px apart, or each star smears into a dotted trail.
    vec2 st = d / r * min(r * 0.0025, 1.4) * f * rim;
    for (int i = 1; i < 3; i++) bg += sky(pp - float(i) * st);
    bg /= 3.0;
  }
  float swell = 4.0 * f * (1.0 - f);
  bg *= mix(vec3(1.0), vec3(0.85, 0.95, 1.2), f);
  bg += bg * (1.0 - bg) * (0.15 * f + 0.25 * swell) * exp(-r / (0.12 * S));
  bg *= 1.0 - 0.18 * inh * exp(-r / (0.04 * S));
  bg += bg * (1.0 - bg) * 0.5 * gro * exp(-r / (0.05 * S));

  float th = atan(d.y, d.x) * 0.15915494 + 0.5;
  float K = 0.055 * S;
  float dx = abs(px.x - uLaneX);
  float lane = (1.0 - smoothstep(uLaneW - 55.0, uLaneW + 15.0, dx)) * smoothstep(40.0, 130.0, px.y) * (1.0 - 0.85 * exp(-r / 45.0));
  vec3 add = vec3(0.0), heads = vec3(0.0);
  // Streaks are drawn at rs, past where they sit, so on the in-breath they slide back toward the star.
  float rs = r + 0.054 * S * inh * (1.0 - exp(-r / (0.3 * S)));
  // Layers 7-9 start close so the far field always has long streaks; 10-11 are near stars: few, thick, seen only once big.
  for (int i = 2; i < 12; i++) {
    float fi = float(i);
    float nl = step(9.5, fi);
    float ml = step(6.5, fi) - nl;
    float bins = nl > 0.5 ? 13.0 + (fi - 10.0) * 9.0 : (ml > 0.5 ? 24.0 + (fi - 7.0) * 10.0 : 90.0 + fi * 30.0);
    float z0 = nl > 0.5 ? 0.3 : (ml > 0.5 ? 0.2 : 1.0);
    float ab = th * bins + fi * 0.37;
    float bi = floor(ab);
    float v = 0.26 + 0.045 * (fi - 2.0 * nl);
    float tt = h1(vec2(bi, fi * 7.13 + 1.0)) + uT * v * mix(1.0, 0.6 / (z0 - 0.035), ml);
    float cyc = floor(tt);
    vec2 hs = h2(vec2(bi * 1.37 + cyc * 17.1, fi * 3.7 + cyc));
    if (hs.x < (nl > 0.5 ? 0.6 : (ml > 0.5 ? 0.45 : 0.62))) continue;
    float near = max(step(0.84, fract(hs.y * 13.7)) * (1.0 - ml), nl);
    float z = mix(0.035, z0, 1.0 - fract(tt));
    // Far streaks can start right at the star, so the burst has a visible centre.
    float rho = mix(ml + nl > 0.5 ? 0.3 : 0.1, 1.7, hs.y);
    float rh = rho * K / z;
    float rt = rho * K / (z + 0.29 * v * f * (1.0 + near));
    float u = clamp((rs - rt) / max(rh - rt, 0.001), 0.0, 1.0);
    float da = (fract(ab) - 0.25 - 0.5 * fract(hs.x * 7.3)) / bins * 6.2831853 * r;
    float dr = rs < rt ? rt - rs : max(rs - rh, 0.0);
    float w0 = min(clamp(0.3 + 0.11 / z, 0.3, 3.6) * (1.0 + 1.8 * near + 1.2 * nl) * mix(0.7, 1.4, fract(hs.y * 7.7)), 6.0);
    // Farther from the star a streak is nearer the ship, so it runs wider and brighter.
    float far = mix(0.6, 1.6, smoothstep(0.0, 0.75 * S, rs));
    float wdt = w0 * (0.45 + 0.55 * u) * far;
    float cellPx = 6.2831853 * r / bins;
    float aa = max(wdt, 0.85);
    float e = (da * da + dr * dr) / (aa * aa);
    float hw = min(wdt * 4.5, 0.14 * cellPx);
    float dh = rs - rh;
    // Every term below is under exp(-9) this far from the streak and its head's bloom, and most of a cell is this far.
    if ((abs(da) > 3.0 * max(hw, 3.0 * wdt + 1.0) || dr > max(3.0 * hw, max(9.0, 4.0 * aa)) + 1.5) && da * da + dh * dh > 9.0 * (30.0 + 8.0 * aa * aa)) continue;
    float lum = smoothstep(0.0, 0.3, 1.0 - z) * clamp(0.09 / z, 0.25, mix(1.6, 2.2, nl)) * mix(0.4, 1.0, hs.x * hs.x) * mix(0.6, 1.25, max(near, ml)) * far * (1.0 - 0.75 * lane * max(near, nl));
    float s = 0.18 * exp(-(da * da + dr * dr) / (hw * hw + 0.01)) * u * u * lum + 0.2 * exp(-da * da / (9.0 * wdt * wdt + 1.0) - dr * dr / 9.0) * u * lum;
    // Each streak fades out before its angular cell ends, so a wide glow is never cut along the cell's edge.
    float cf = smoothstep(0.0, 0.1, min(fract(ab), 1.0 - fract(ab)));
    s *= cf;
    float k = wdt / aa * u * lum * (1.0 + 1.2 * smoothstep(0.85, 1.0, u)) * cf;
    vec3 core = vec3(exp(-e)) * k;
    if (nl + ml > 0.5) {
      float dR = rs < rt - 1.5 ? rt - 1.5 - rs : max(rs - rh + 1.5, 0.0);
      float dB = rs < rt + 1.5 ? rt + 1.5 - rs : max(rs - rh - 1.5, 0.0);
      core = vec3(exp(-(da * da + dR * dR) / (aa * aa)), exp(-e), exp(-(da * da + dB * dB) / (aa * aa))) * k;
    }
    // Violet tail, cyan-blue body, blue-white head; the glow round it stays coloured. A quarter run violet like the gas, a fifth paler.
    vec3 ink = mix(mix(vec3(0.62, 0.3, 1.0), vec3(0.32, 0.62, 1.0), smoothstep(0.1, 0.7, u)), vec3(0.88, 0.95, 1.0), smoothstep(0.75, 1.0, u));
    float hv = fract(hs.y * 5.3);
    vec3 tint = hv < 0.25 ? vec3(1.7, 0.7, 1.0) : (hv > 0.8 ? vec3(1.6, 1.25, 1.0) : vec3(1.0));
    float hd = da * da + dh * dh;
    add += (core * ink + s * mix(vec3(0.55, 0.3, 1.0), vec3(0.3, 0.62, 1.0), u) * 1.4) * tint + vec3(0.3, 0.5, 1.0) * exp(-hd / (30.0 + 8.0 * aa * aa)) * 0.35 * f * lum * cf;
    // A pinpoint white-hot head inside that blue bloom; at rest the bloom goes and the point stays.
    heads += exp(-hd / (min(aa, 1.8) * min(aa, 1.8) * 1.2)) * min(wdt, 2.5) * 0.8 * lum * cf;
  }
  // Streaks fade across the see-through header so its title stays on a calm sky.
  float seam = uSize.x > 700.0 ? smoothstep(0.0, 200.0, px.x) : 1.0;
  float fade = smoothstep(6.0, 45.0, r) * (0.1 + 0.9 * smoothstep(40.0, 140.0, px.y)) * seam;
  // At rest the streaks are gone and their heads stay as faint points: a still star field in front of the nebula.
  add *= fade * smoothstep(0.0, 0.25, f);
  heads *= fade * mix(0.3, 1.0, smoothstep(0.0, 0.25, f));

  vec2 ad = abs(d);
  float br = 1.0 - 0.3 * inh + 0.9 * gro;
  vec3 flare = (vec3(0.65, 0.82, 1.0) * exp(-r / (14.0 + 10.0 * gro)) * 0.8 + vec3(0.45, 0.45, 1.0) * exp(-r / (90.0 + 45.0 * gro)) * 0.14) * f * br;
  flare += vec3(0.3, 0.5, 1.0) * exp(-ad.y * ad.y / 8.0) * exp(-ad.x / (uSize.x * 0.22)) * 0.3 * f + vec3(0.35, 0.5, 1.0) * exp(-r / ((0.07 + 0.03 * gro) * S)) * 0.45 * f * (1.0 - 0.3 * inh + 0.6 * gro);
  // Over the column streaks keep their hue at lower strength: per-channel tone mapping would turn a bright one grey there.
  // A phone's column spans the screen and its text sits on opaque cards, so there the streaks dim less.
  float sl = lane * (uSize.x > 700.0 ? 1.0 : 0.6);
  float mx = max(add.r, max(add.g, add.b));
  vec3 L = mix(1.0 - exp(-add), add * ((1.0 - exp(-mx)) / max(mx, 1e-4)) * vec3(0.09, 0.14, 0.21), sl);
  L += (1.0 - L) * (1.0 - exp(-flare * mix(1.0, 0.25, lane) - heads * vec3(1.0, 0.97, 0.92) * mix(1.0, 0.08, sl)));

  float calm = uBox.z > 0.0 ? smoothstep(uBox.y - 110.0, uBox.y - 40.0, px.y) * (1.0 - smoothstep(uLaneW - 55.0, uLaneW + 15.0, dx)) : 0.0;
  // Under the column the sky is dimmed and its highlights squeezed, so grey text keeps its contrast over the bright gas.
  float bLum = dot(bg, vec3(0.3, 0.5, 0.2));
  // Toward the bot list's edge the sky dims, so it meets the dark sidebar without a seam.
  bg *= mix(1.0, 0.75 / (1.0 + bLum * 0.75 / 0.3), lane) * (1.0 - 0.35 * calm) * (0.2 + 0.8 * seam);
  // Squeezed highlights turn grey, and grey filaments read olive against blue gas, so they take the gas's blue.
  bg *= mix(vec3(1.0), vec3(0.78, 0.88, 1.3), lane * smoothstep(0.15, 0.5, bLum));
  L *= 1.0 - 0.75 * calm;
  vec3 col = bg + (1.0 - bg) * L;
  col += (h1(gl_FragCoord.xy + fract(uT * 7.31) * 413.0) - 0.5) * 0.02;
  gl_FragColor = vec4(col, 1.0);
}`;

const FRAME_UNIFORMS = ["uSize", "uBuf", "uF", "uT", "uFlow", "uLaneX", "uLaneW", "uBox", "uMap", "uPlate"] as const;

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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
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

  const render = () => {
    if (!gl || !ready || !shown || !width) return;
    const p = shown;
    // Cover the layer, put the star where the plate says, then pull back so no edge of the plate shows.
    const s = Math.max(width / p.w, height / p.h);
    const ox = Math.min(0, Math.max(width - p.w * s, width - p.tr - p.ax * s));
    const oy = Math.min(0, Math.max(height - p.h * s, height * p.ty - p.ay * s));
    gl.useProgram(frameProg);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uSize, width, height);
    gl.uniform2f(U.uBuf, canvas.width, canvas.height);
    gl.uniform2f(U.uF, ox + p.ax * s, oy + p.ay * s);
    gl.uniform1f(U.uT, clock);
    gl.uniform1f(U.uFlow, flow);
    // The scene calms under the transcript so timestamps and actions stay readable over it.
    const col = main?.querySelector("[data-orbit-transcript] > div");
    const lane = col ? api.rectIn(col) : { cx: -1e5, w: 0 };
    gl.uniform1f(U.uLaneX, lane.cx);
    gl.uniform1f(U.uLaneW, lane.w / 2 + 40);
    const box = main?.querySelector("[data-orbit-composer-frame]");
    const b = box ? api.rectIn(box) : { x: 0, y: 0, w: 0, h: 0 };
    gl.uniform4f(U.uBox, b.x, b.y, b.w, b.h);
    gl.uniform4f(U.uMap, 1 / (s * p.w), 1 / (s * p.h), -ox / (s * p.w), -oy / (s * p.h));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, plate);
    gl.uniform1i(U.uPlate, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Star points are a pixel wide, so the buffer follows the screen's density. Layout size: a theme tile shrinks its layer with a transform.
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
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
const warp: SceneModule = { pauseOnBlur: true, create };
export default warp;
