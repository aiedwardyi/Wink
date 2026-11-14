// Snow: flakes fall behind the chat while Wink works, a puff on send, a gust
// on reply, then time slows to a frozen still with caps on the bubbles and the
// chat box. Falling stops after 30 s even if the turn runs on.
import type { SceneApi, SceneModule } from "./scene-host";

const FALL_CAP_MS = 30000;
const CAPPED = "[data-orbit-message-content], [data-orbit-composer-frame]";

type Flake = {
  z: number; crystal: boolean; v: number; x: number; y: number; vy: number; amp: number; freq: number; ph: number;
  rot: number; vr: number; a: number; rank: number; alpha: number; ix: number; iy: number;
};
type Sprites = { far: HTMLCanvasElement; mid: HTMLCanvasElement; near: HTMLCanvasElement; crystals: HTMLCanvasElement[]; big: HTMLCanvasElement[] };

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot(size: number, soft: boolean, light: boolean, dpr: number) {
  const r = Math.ceil(size * dpr) + 2;
  const c = document.createElement("canvas");
  c.width = c.height = r * 2;
  const x = c.getContext("2d")!;
  const gr = x.createRadialGradient(r, r, 0, r, r, size * dpr);
  if (light) {
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(soft ? 0.4 : 0.42, "rgba(255,255,255,1)");
    gr.addColorStop(soft ? 0.62 : 0.66, "rgba(104,132,176,0.9)");
    gr.addColorStop(1, "rgba(104,132,176,0)");
  } else {
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(soft ? 0.3 : 0.55, "rgba(240,246,255,0.92)");
    gr.addColorStop(1, "rgba(225,236,255,0)");
  }
  x.fillStyle = gr;
  x.fillRect(0, 0, r * 2, r * 2);
  return c;
}

function crystal(size: number, variant: number, light: boolean, dpr: number) {
  const r = Math.ceil(size * dpr) + 3;
  const c = document.createElement("canvas");
  c.width = c.height = r * 2;
  const x = c.getContext("2d")!;
  x.translate(r, r);
  const arm = size * dpr;
  const b1 = [0.42, 0.5, 0.36][variant];
  const b2 = [0.7, 0.74, 0.66][variant];
  const path = () => {
    x.beginPath();
    for (let k = 0; k < 6; k++) {
      const ang = (k * Math.PI) / 3;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const P = (d: number, o: number): [number, number] => [ca * d - sa * o, sa * d + ca * o];
      x.moveTo(0, 0);
      x.lineTo(...P(arm, 0));
      for (const [at, len] of [[b1, 0.3], [b2, 0.2]]) {
        x.moveTo(...P(arm * at, 0));
        x.lineTo(...P(arm * (at + len * 0.75), arm * len * 0.62));
        x.moveTo(...P(arm * at, 0));
        x.lineTo(...P(arm * (at + len * 0.75), -arm * len * 0.62));
      }
    }
  };
  x.lineCap = "round";
  if (light) {
    x.strokeStyle = "rgba(88,116,162,0.95)";
    x.lineWidth = Math.max(2.2, arm * 0.2);
    path();
    x.stroke();
  }
  x.strokeStyle = "rgba(255,255,255,0.98)";
  x.lineWidth = Math.max(1, arm * 0.085);
  path();
  x.stroke();
  x.fillStyle = "rgba(255,255,255,1)";
  x.beginPath();
  x.arc(0, 0, Math.max(1, arm * 0.12), 0, 7);
  x.fill();
  return c;
}

function create(api: SceneApi) {
  const canvas = document.createElement("canvas");
  api.layer.append(canvas);
  const g = canvas.getContext("2d")!;
  const main = api.layer.parentElement;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let flakes: Flake[] = [];
  let sprites: Sprites | null = null;
  let rnd = mulberry32(1114);
  let clock = 0;
  let scale = 0;
  let scaleTarget = 0;
  let density = 0.5;
  let densityTarget = 0.5;
  let fallStarted = 0;
  let settleAt = -1;
  let gust = 0;
  let gustDir = 1;

  const buildSprites = () => {
    const light = !api.dark();
    sprites = {
      far: dot(light ? 2.2 : 1.8, false, light, dpr), mid: dot(light ? 3.2 : 2.8, false, light, dpr), near: dot(5.8, true, light, dpr),
      crystals: [0, 1, 2].map((v) => crystal(9.5, v, light, dpr)), big: [0, 1, 2].map((v) => crystal(16, v, light, dpr)),
    };
  };

  const spawn = (f: Partial<Flake>, anywhere: boolean): Flake => {
    const p = rnd();
    const z = p < 0.56 ? 0 : p < 0.9 ? 1 : 2;
    const crystalKind = z === 1 ? rnd() < 0.24 : z === 2 ? rnd() < 0.55 : false;
    return Object.assign(f, {
      z, crystal: crystalKind, v: Math.floor(rnd() * 3),
      x: rnd() * W, y: anywhere ? rnd() * H : -24 - rnd() * 60,
      vy: [15, 30, 54][z] * (0.8 + rnd() * 0.45),
      amp: [5, 10, 18][z] * (0.6 + rnd() * 0.8), freq: 0.35 + rnd() * 0.55, ph: rnd() * 6.283,
      rot: rnd() * 6.283, vr: (rnd() - 0.5) * 0.9,
      a: [0.55, 0.85, 0.95][z] * (0.8 + rnd() * 0.2),
      rank: rnd(), alpha: anywhere ? 1 : 0, ix: 0, iy: 0,
    });
  };

  const seed = () => {
    rnd = mulberry32(1114);
    const n = Math.round(Math.min(300, Math.max(100, (W * H) / 4300)));
    flakes = Array.from({ length: n }, () => spawn({}, true));
  };

  const draw = () => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!sprites) return;
    for (const f of flakes) {
      const al = Math.min(f.alpha, 1) * f.a * (f.rank < density ? 1 : 0);
      if (al < 0.01) continue;
      g.globalAlpha = al;
      if (f.crystal) {
        const sp = (f.z === 2 ? sprites.big : sprites.crystals)[f.v];
        const h = sp.width / 2;
        const c = Math.cos(f.rot);
        const s = Math.sin(f.rot);
        g.setTransform(c, s, -s, c, f.x * dpr, f.y * dpr);
        g.drawImage(sp, -h, -h);
        g.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        const sp = f.z === 0 ? sprites.far : f.z === 1 ? sprites.mid : sprites.near;
        const h = sp.width / 2;
        g.drawImage(sp, f.x * dpr - h, f.y * dpr - h);
      }
    }
    g.globalAlpha = 1;
  };

  const resize = () => {
    const r = api.layer.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width));
    const nh = Math.max(1, Math.round(r.height));
    dpr = Math.min(2, devicePixelRatio || 1);
    const sx = W ? nw / W : 1;
    const sy = H ? nh / H : 1;
    W = nw;
    H = nh;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (!flakes.length) seed();
    else for (const f of flakes) {
      f.x *= sx;
      f.y *= sy;
    }
    buildSprites();
    draw();
  };

  const step = (dt: number) => {
    const k = dt / 1000;
    // Time itself slows to a stop, so the last frame is a still that costs nothing.
    const tau = scaleTarget > scale ? 0.45 : 0.75;
    scale += (scaleTarget - scale) * (1 - Math.exp(-k / tau));
    if (scaleTarget === 0 && scale < 0.02) scale = 0;
    density += (densityTarget - density) * (1 - Math.exp(-k / 0.9));
    const s = k * scale;
    clock += s;
    gust *= Math.exp(-k / 1.1);
    for (const f of flakes) {
      const sway = Math.cos(clock * f.freq * 6.283 + f.ph) * f.amp * f.freq * 1.2;
      f.x += (sway + f.ix + gust * gustDir * (0.5 + f.z * 0.35)) * s;
      f.y += (f.vy + f.iy) * s;
      const damp = Math.exp(-s * 2.4);
      f.ix *= damp;
      f.iy *= damp;
      f.rot += f.vr * s;
      if (f.alpha < 1) f.alpha = Math.min(1, f.alpha + k * 1.6);
      if (f.y > H + 30) spawn(f, false);
      if (f.x < -30) f.x += W + 60;
      else if (f.x > W + 30) f.x -= W + 60;
    }
  };

  const puff = (cx: number, cy: number, radius: number, power: number, lift: number) => {
    for (const f of flakes) {
      const dx = f.x - cx;
      const dy = f.y - cy;
      const d = Math.hypot(dx, dy);
      if (d > radius || d < 1) continue;
      const s = (1 - d / radius) ** 1.5 * power * (0.6 + f.z * 0.3);
      f.ix += (dx / d) * s;
      f.iy += (dy / d) * s - lift * (1 - d / radius);
    }
  };

  // A cap grows once per element: 0 then a reflow then 1 starts its transition.
  const caps = (on: boolean) => {
    for (const el of (main ?? document).querySelectorAll<HTMLElement>(CAPPED)) {
      if (!on) {
        delete el.dataset.snowcap;
        continue;
      }
      if (el.dataset.snowcap === "1") continue;
      el.dataset.snowcap = "0";
      el.getBoundingClientRect();
      el.dataset.snowcap = "1";
    }
    main?.toggleAttribute("data-snow-still", api.reduced());
  };

  const reply = (at?: Element) => {
    if (api.reduced()) {
      density = densityTarget = 0.55;
      draw();
      return;
    }
    if (at) {
      const r = api.rectIn(at);
      puff(r.x + 24, r.cy, 260, 150, 40);
    }
    gust = 34;
    gustDir = 1;
    if (scaleTarget === 0) scaleTarget = 1;
    settleAt = api.time() + 1400;
    api.wake();
    caps(true);
  };

  const sizes = new ResizeObserver(resize);
  sizes.observe(api.layer);

  return {
    frame(t: number, dt: number) {
      if (settleAt >= 0 && t >= settleAt) {
        scaleTarget = 0;
        densityTarget = 0.55;
        settleAt = -1;
      }
      if (scaleTarget > 0 && t - fallStarted > FALL_CAP_MS) {
        scaleTarget = 0;
        densityTarget = 0.6;
      }
      step(dt);
      draw();
      return !(scaleTarget === 0 && scale === 0);
    },
    event(event) {
      if (event.name === "skin") {
        buildSprites();
        draw();
        return;
      }
      if (event.name === "motion") return draw();
      if (event.name === "reply") return reply(event.at);
      if (api.reduced()) {
        if (event.name === "busy") {
          density = densityTarget = 1;
          for (const f of flakes) f.alpha = 1;
          draw();
          caps(true);
        }
        return;
      }
      if (event.name === "send") {
        const r = api.rectIn(event.at);
        puff(r.cx, r.y, 300, 260, 140);
        gust = 26;
        gustDir = -1;
      }
      if (event.name === "busy") {
        scaleTarget = 1;
        densityTarget = 1;
        settleAt = -1;
        fallStarted = api.time();
        api.wake();
        api.after(60, () => caps(true));
      }
    },
    dispose() {
      sizes.disconnect();
      caps(false);
      main?.removeAttribute("data-snow-still");
      canvas.remove();
    },
  } satisfies ReturnType<SceneModule["create"]>;
}

// The longest runner, so it also rests while the window is in the background.
const snow: SceneModule = { pauseOnBlur: true, create };
export default snow;
