// A one-pass shader scene on Neon Grid's motion rule: it rolls while Wink
// works and glides to a still on reply. The shader gets uT, a clock that only
// moves with the flow, and uFlow, how fast it moves now.
import type { SceneApi, SceneModule } from "./scene-host";

const ROLL_CAP_MS = 30000;

export type FlowSpec = {
  frag: string;
  colors: Record<string, string>;
  /** Seconds after which every motion in the shader repeats; uT wraps there so it never loses float precision. */
  period: number;
  /** Thin lines need the screen's density; soft looks upsample cleanly from css px. */
  sharp?: boolean;
  /** Painted once per size into uTex, at the buffer's density. */
  backdrop?: (g: CanvasRenderingContext2D, w: number, h: number) => void;
  /** Built with the backdrop into uTex2 as raw RGBA, so all four channels carry data (a canvas would zero the colour wherever alpha is 0). */
  extra?: (w: number, h: number, dpr: number) => ImageData | null;
};

const VERT = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";
const BASE = ["uSize", "uBuf", "uT", "uFlow", "uLaneX", "uLaneW", "uTex", "uTex2"];
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export function flowScene(spec: FlowSpec): SceneModule {
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
    const U: Record<string, WebGLUniformLocation | null> = {};
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
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, spec.frag));
      gl.linkProgram(prog);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, "a");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        for (const name of [...BASE, ...Object.keys(spec.colors)]) U[name] = gl.getUniformLocation(prog, name);
        for (const [name, value] of Object.entries(spec.colors)) gl.uniform3fv(U[name], hex(value));
        if (spec.backdrop) {
          gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
          for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
          gl.uniform1i(U.uTex, 0);
        }
        if (spec.extra) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
          for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
          gl.uniform1i(U.uTex2, 1);
          gl.activeTexture(gl.TEXTURE0);
        }
        ready = true;
      } else gl.deleteProgram(prog);
    }
    if (!ready) api.layer.style.background = "linear-gradient(180deg, var(--color-app), var(--color-panel))";

    const render = () => {
      if (!gl || !ready) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(U.uSize, width, height);
      gl.uniform2f(U.uBuf, canvas.width, canvas.height);
      gl.uniform1f(U.uT, clock);
      gl.uniform1f(U.uFlow, flow);
      // The scene dims under the transcript so timestamps and actions stay readable over it.
      const col = main?.querySelector("[data-orbit-transcript] > div");
      const lane = col ? api.rectIn(col) : { cx: -1e5, w: 0 };
      gl.uniform1f(U.uLaneX, lane.cx);
      gl.uniform1f(U.uLaneW, lane.w / 2 + 40);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // Layout size: a theme tile shrinks its layer with a transform.
    const resize = () => {
      const dpr = spec.sharp || spec.backdrop || spec.extra ? Math.min(2, devicePixelRatio || 1) : 1;
      width = Math.max(1, api.layer.clientWidth);
      height = Math.max(1, api.layer.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      if (gl && ready && spec.backdrop) {
        const paper = document.createElement("canvas");
        paper.width = canvas.width;
        paper.height = canvas.height;
        const g = paper.getContext("2d");
        if (g) {
          g.scale(dpr, dpr);
          spec.backdrop(g, width, height);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paper);
        }
      }
      const extra = gl && ready && spec.extra?.(width, height, dpr);
      if (gl && extra) {
        gl.activeTexture(gl.TEXTURE1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, extra);
        gl.activeTexture(gl.TEXTURE0);
      }
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
        clock = (clock + k * flow) % spec.period;
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
  return { pauseOnBlur: true, create };
}
