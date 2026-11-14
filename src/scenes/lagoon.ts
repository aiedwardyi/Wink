// Lagoon: water caustics behind the chat, one shader pass; the JS only sets
// uniforms. Send drops a ripple from the chat box, the reply a smaller one
// from its bubble, and at night the ripple lights plankton.
import type { SceneApi, SceneModule } from "./scene-host";

const SPEED = 260;
const RIPPLE_LIFE = 4.6;
const PALETTE = {
  "lagoon-night": { shal: "#114550", deep: "#06232b", light: [0.13, 0.52, 0.5], spark: [0.45, 1.0, 0.86], night: 1, calm: 0.3, veil: "#0d343c" },
  lagoon: { shal: "#e0f4f1", deep: "#a3dcd5", light: [0.4, 0.46, 0.44], spark: [0, 0, 0], night: 0, calm: 0.34, veil: "#d6efeb" },
} as const;
type Palette = (typeof PALETTE)[keyof typeof PALETTE];

const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";
const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uT, uNight, uLaneX, uLaneW, uCalm;
uniform vec4 uR[4];
uniform vec3 uDeep, uShal, uLight, uSpark;
vec2 h2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float h1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float cell(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = h2(i + g);
    o = 0.5 + 0.38 * sin(t + 6.2831 * o);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return sqrt(d2) - sqrt(d1);
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  vec2 p = px;
  float crest = 0.0;
  for (int k = 0; k < 4; k++) {
    vec4 r = uR[k];
    if (r.w <= 0.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 0.001;
    float x = (dist - r.z * ${SPEED}.0) / (30.0 + r.z * 26.0);
    float band = exp(-x * x);
    float env = r.w * exp(-r.z * 0.85) * smoothstep(0.0, 0.12, r.z);
    p += d / dist * band * sin(x * 3.4) * env * 17.0;
    crest += band * env * max(0.0, cos(x * 3.4));
  }
  vec2 q = p / 165.0;
  q += 0.2 * vec2(sin(q.y * 1.7 + uT * 0.35), cos(q.x * 1.5 - uT * 0.3));
  float a = cell(q, uT * 0.55);
  float b = cell(q * 1.63 + 4.2, uT * 0.42 + 1.7);
  float la = exp(-a * 11.0), lb = exp(-b * 13.0);
  float c = la * 0.55 + lb * 0.35 + la * lb * 1.2 + exp(-a * 3.5) * 0.16;
  float lane = smoothstep(uLaneW, uLaneW * 0.6, abs(px.x - uLaneX));
  float gain = mix(1.0, uCalm, lane);
  vec2 uv = px / uSize;
  float depth = clamp(uv.y * 0.55 + length((uv - vec2(0.5, 0.3)) * vec2(1.2, 1.0)) * 0.7, 0.0, 1.0);
  vec3 col = mix(uShal, uDeep, depth);
  col += uLight * c * gain + uLight * crest * 0.22;
  if (uNight > 0.5) {
    vec2 gc = floor(px / 16.0);
    float spark = 0.0;
    for (int yy = -1; yy <= 1; yy++) for (int xx = -1; xx <= 1; xx++) {
      vec2 cc = gc + vec2(float(xx), float(yy));
      float hh = h1(cc);
      if (hh < 0.7) continue;
      vec2 sp = (cc + 0.15 + 0.7 * h2(cc + 3.1)) * 16.0;
      float sd2 = dot(px - sp, px - sp);
      float lit = hh > 0.965 ? 0.12 : 0.0;
      for (int k = 0; k < 4; k++) {
        vec4 r = uR[k];
        if (r.w <= 0.0) continue;
        // Clamp before exp: far from a ripple exp(-tp * 28) overflows, and 0 * inf is NaN (black on D3D).
        float tp = max(r.z - length(sp - r.xy) / ${SPEED}.0, 0.0);
        lit += exp(-tp * 1.3) * (1.0 - exp(-tp * 28.0)) * r.w;
      }
      float tw = 0.65 + 0.35 * sin(uT * 3.0 + hh * 40.0);
      spark += lit * tw * (exp(-sd2 / 4.5) + 0.32 * exp(-sd2 / 42.0));
    }
    col += uSpark * spark * mix(1.6, 0.55, lane);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const UNIFORMS = ["uSize", "uBuf", "uT", "uNight", "uLaneX", "uLaneW", "uCalm", "uR", "uDeep", "uShal", "uLight", "uSpark"] as const;
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

type Ripple = { x: number; y: number; age: number; s: number };

function create(api: SceneApi) {
  const canvas = document.createElement("canvas");
  api.layer.append(canvas);
  const main = api.layer.parentElement;
  const pal = (): Palette => PALETTE[api.skin() as keyof typeof PALETTE] ?? PALETTE["lagoon-night"];
  const veil = () => main?.style.setProperty("--scene-veil", pal().veil);
  let width = 0;
  let height = 0;
  let flowT = 7.3;
  let flow = 0;
  let flowTarget = 0;
  let flowUntil = -1;
  let ripples: Ripple[] = [];

  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
  const U = {} as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  let ready = false;
  if (gl) {
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "a");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const name of UNIFORMS) U[name] = gl.getUniformLocation(prog, name);
      ready = true;
    }
  }
  // No WebGL: a plain gradient in the theme's colors.
  if (!ready) api.layer.style.background = "linear-gradient(180deg, var(--color-app), var(--color-panel))";

  const render = () => {
    if (!gl || !ready) return;
    const p = pal();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uSize, width, height);
    gl.uniform2f(U.uBuf, canvas.width, canvas.height);
    gl.uniform1f(U.uT, flowT);
    gl.uniform1f(U.uNight, p.night);
    const col = main?.querySelector("[data-orbit-transcript] > div");
    const lane = col ? api.rectIn(col) : { cx: width / 2, w: 960 };
    gl.uniform1f(U.uLaneX, lane.cx);
    gl.uniform1f(U.uLaneW, lane.w / 2 + 40);
    gl.uniform1f(U.uCalm, p.calm);
    const r = new Float32Array(16);
    ripples.slice(-4).forEach((x, i) => r.set([x.x, x.y, x.age, x.s], i * 4));
    gl.uniform4fv(U.uR, r);
    gl.uniform3fv(U.uDeep, hex(p.deep));
    gl.uniform3fv(U.uShal, hex(p.shal));
    gl.uniform3fv(U.uLight, p.light);
    gl.uniform3fv(U.uSpark, p.spark);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // The water is soft, so one buffer px per css px upsamples cleanly.
  const resize = () => {
    const r = api.layer.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    canvas.width = width;
    canvas.height = height;
    render();
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(api.layer);
  veil();

  const ripple = (x: number, y: number, s: number) => {
    ripples.push({ x, y, age: 0, s });
    flowTarget = 1;
    flowUntil = api.time() + 2600;
    api.wake();
  };

  return {
    frame(t: number, dt: number) {
      const k = dt / 1000;
      if (flowUntil >= 0 && t >= flowUntil) {
        flowTarget = 0;
        flowUntil = -1;
      }
      flow += (flowTarget - flow) * (1 - Math.exp(-k / (flowTarget > flow ? 0.35 : 0.9)));
      // Below 2% the drift is invisible, so stop there instead of rendering seconds of near-still water.
      if (flowTarget === 0 && flow < 0.02) flow = 0;
      flowT += k * flow;
      for (const x of ripples) x.age += k;
      ripples = ripples.filter((x) => x.age < RIPPLE_LIFE);
      render();
      return flow > 0 || ripples.length > 0;
    },
    event(event) {
      if (!ready) return;
      if (event.name === "skin") {
        veil();
        render();
        return;
      }
      if (event.name === "motion") return render();
      if (api.reduced()) return;
      if (event.name === "send") {
        const r = api.rectIn(event.at);
        ripple(r.cx, r.y + 6, 1);
      }
      if (event.name === "reply" && event.at) {
        const r = api.rectIn(event.at);
        ripple(r.x + 36, r.y + 18, 0.85);
      }
    },
    dispose() {
      sizes.disconnect();
      main?.style.removeProperty("--scene-veil");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      api.layer.style.background = "";
    },
  } satisfies ReturnType<SceneModule["create"]>;
}

const lagoon: SceneModule = { pauseOnBlur: false, create };
export default lagoon;
