// Neon Grid: a striped sunset over a perspective grid, one shader pass; the JS
// only sets uniforms. The floor rolls toward the viewer while Wink works and
// glides to a still on reply; the sun and the sky never move.
import type { SceneApi, SceneModule } from "./scene-host";

const ROLL_CAP_MS = 30000;
const CELL = 0.37;
const FOCAL = 550;
const SKY = "#100c25";
const HAZE = "#3a1450";
const PINK = "#ff3ec8";
const CYAN = "#3ad8ff";
const SUN_TOP = "#ffd66b";
const SUN_LOW = "#ff2d95";

const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";
const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uOff, uLaneX, uLaneW;
uniform vec3 uSky, uHaze, uPink, uCyan, uSunTop, uSunLow;
float h1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float tri(float x) { return abs(fract(x) - 0.5) * 2.0; }
float line(float d) { return smoothstep(1.3, 0.3, d) + 0.22 * exp(-d / 2.5); }
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  float hy = floor(uSize.y * 0.62);
  float cx = uSize.x * 0.5;
  float r = clamp(min(uSize.x, uSize.y) * 0.14, 40.0, 120.0);
  vec3 col;
  if (px.y < hy) {
    float u = px.y / hy;
    col = mix(uSky, uHaze, smoothstep(0.4, 1.0, u) * 0.85);
    vec2 cell = floor(px / 26.0);
    float hs = h1(cell);
    if (hs > 0.9) {
      vec2 sp = (cell + 0.2 + 0.6 * vec2(h1(cell + 7.1), h1(cell + 3.3))) * 26.0;
      col += vec3(0.85, 0.8, 1.0) * exp(-dot(px - sp, px - sp) / 0.9) * (1.0 - u) * (hs - 0.9) * 6.0;
    }
    vec2 c = vec2(cx, hy - r * 0.62);
    float d = length(px - c);
    col += uSunLow * exp(-max(d - r, 0.0) / (r * 0.55)) * 0.32;
    float sun = smoothstep(r + 0.8, r - 0.8, d);
    if (sun > 0.0) {
      float top = c.y - r * 0.05;
      float v = clamp((px.y - top) / (hy - top), 0.0, 1.0);
      float period = r * 0.17;
      float s = fract((hy - px.y) / period);
      float gap = px.y > top ? 0.06 + 0.5 * v : 0.0;
      sun *= smoothstep(gap, gap + 1.2 / period, s);
      col = mix(col, mix(uSunTop, uSunLow, smoothstep(c.y - r, hy, px.y)) * 0.92, sun);
    }
    float x = px.x;
    float mh = r * 0.62 * (0.55 * tri(x / 260.0 + 0.3) + 0.3 * tri(x / 110.0 + 0.7) + 0.15 * tri(x / 47.0 + 0.1));
    mh *= mix(0.3, 1.0, smoothstep(r * 0.5, r * 2.6, abs(x - cx)));
    float edge = px.y - (hy - mh);
    if (edge > 0.0) col = mix(vec3(0.09, 0.04, 0.17), vec3(0.16, 0.05, 0.24), edge / max(mh, 1.0)) + uPink * exp(-edge / 1.4) * 0.35;
  } else {
    float dy = px.y - hy + 0.5;
    // A small floor (a theme tile, a phone) is the desktop floor shrunk, so its rows stay as many and as visible.
    float k = max(0.15, (uSize.y - hy) / 342.0);
    float z = ${FOCAL}.0 * k / dy;
    float ppz = dy * dy / (${FOCAL}.0 * k);
    float dh = abs(fract((z + uOff) / ${CELL} + 0.5) - 0.5) * ${CELL} * ppz;
    float slope = (px.x - cx) / dy;
    float across = ${CELL} * dy / sqrt(1.0 + slope * slope);
    float dv = abs(fract(slope / ${CELL} + 0.5) - 0.5) * across;
    float fadeH = smoothstep(2.0, 8.0, ${CELL} * ppz);
    float fadeV = smoothstep(4.0, 14.0, across);
    float lane = smoothstep(uLaneW, uLaneW * 0.6, abs(px.x - uLaneX));
    float fog = mix(0.3, 1.0, smoothstep(0.0, 160.0, dy)) * mix(1.0, 0.45, lane);
    vec3 lc = mix(uPink, uCyan, smoothstep(0.2, 1.0, abs(px.x - cx) / cx));
    col = mix(uHaze * 0.7, uSky * 0.75, smoothstep(0.0, 70.0, dy));
    col += uPink * (line(dh) * fadeH + (1.0 - fadeH) * 0.1) * 0.75 * fog;
    col += lc * (line(dv) * fadeV + (1.0 - fadeV) * 0.06) * 0.7 * fog;
    col += uPink * exp(-dy / 2.0) * 0.6;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const UNIFORMS = ["uSize", "uBuf", "uOff", "uLaneX", "uLaneW", "uSky", "uHaze", "uPink", "uCyan", "uSunTop", "uSunLow"] as const;
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function create(api: SceneApi) {
  const canvas = document.createElement("canvas");
  api.layer.append(canvas);
  const main = api.layer.parentElement;
  let width = 0;
  let height = 0;
  let off = 0;
  let flow = 0;
  let flowTarget = 0;
  let settleAt = -1;
  let capAt = Infinity;

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
      gl.uniform3fv(U.uSky, hex(SKY));
      gl.uniform3fv(U.uHaze, hex(HAZE));
      gl.uniform3fv(U.uPink, hex(PINK));
      gl.uniform3fv(U.uCyan, hex(CYAN));
      gl.uniform3fv(U.uSunTop, hex(SUN_TOP));
      gl.uniform3fv(U.uSunLow, hex(SUN_LOW));
      ready = true;
    } else gl.deleteProgram(prog);
  }
  if (!ready) api.layer.style.background = "linear-gradient(180deg, var(--color-app), var(--color-panel))";

  const render = () => {
    if (!gl || !ready) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uSize, width, height);
    gl.uniform2f(U.uBuf, canvas.width, canvas.height);
    gl.uniform1f(U.uOff, off);
    // The floor dims under the transcript so timestamps and actions stay readable over it.
    const col = main?.querySelector("[data-orbit-transcript] > div");
    const lane = col ? api.rectIn(col) : { cx: -1e5, w: 0 };
    gl.uniform1f(U.uLaneX, lane.cx);
    gl.uniform1f(U.uLaneW, lane.w / 2 + 40);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // Grid lines are 1 px wide, so the buffer follows the screen's density. Layout size: a theme tile shrinks its layer with a transform.
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    width = Math.max(1, api.layer.clientWidth);
    height = Math.max(1, api.layer.clientHeight);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
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
      off = (off + k * flow * CELL * 0.45) % CELL;
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
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      api.layer.style.background = "";
    },
  } satisfies ReturnType<SceneModule["create"]>;
}

// A turn can run for minutes, so it also rests while the window is in the background.
const neonGrid: SceneModule = { pauseOnBlur: true, create };
export default neonGrid;
