// Night Rain: a drinking alley at night, neon signs down both walls and their
// light smeared on the wet street. The alley is painted once per size; the
// shader adds the rain, the ripples and the reflections.
import { flowScene } from "./flow";

const FONT = '"Yu Gothic UI", "Yu Gothic", Meiryo, "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", sans-serif';
const SIGNS: [string, string][] = [
  ["居酒屋", "#ff4f7b"], ["ラーメン", "#48e3ff"], ["酒", "#ffb347"], ["バー", "#c86bff"], ["焼鳥", "#ff4f7b"],
  ["営業中", "#5cffb0"], ["カラオケ", "#48e3ff"], ["深夜", "#ff6ad5"], ["食堂", "#ffb347"], ["スナック", "#c86bff"],
];

function glow(g: CanvasRenderingContext2D, color: string, blur: number, draw: () => void) {
  g.save();
  g.shadowColor = color;
  g.shadowBlur = blur;
  draw();
  g.restore();
}

function paint(g: CanvasRenderingContext2D, w: number, h: number) {
  const k = Math.max(0.45, Math.min(1.3, h / 860));
  const hy = h * 0.6;
  const vx = w * 0.5;
  const sky = g.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, "#04050c");
  sky.addColorStop(1, "#151030");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const haze = g.createRadialGradient(vx, hy, 0, vx, hy, h * 0.55);
  haze.addColorStop(0, "rgba(255, 70, 160, 0.28)");
  haze.addColorStop(1, "rgba(255, 70, 160, 0)");
  g.fillStyle = haze;
  g.fillRect(0, 0, w, h);

  // Far blocks at the alley's end, a few windows lit.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = "#0a0a1a";
  for (let x = vx - 150 * k; x < vx + 150 * k; x += 16 * k) {
    const bh = (30 + rnd() * 90) * k;
    g.fillRect(x, hy - bh, 15 * k, bh);
    for (let i = 0; i < 4; i++) if (rnd() > 0.55) {
      g.fillStyle = rnd() > 0.5 ? "rgba(255, 196, 120, 0.55)" : "rgba(120, 220, 255, 0.45)";
      g.fillRect(x + 3 * k + rnd() * 8 * k, hy - bh + 6 * k + rnd() * (bh - 12 * k), 2 * k, 3 * k);
      g.fillStyle = "#0a0a1a";
    }
  }

  // The two walls, near edge at the screen side, far edge at the alley's end.
  const far = 150 * k;
  for (const side of [-1, 1]) {
    const nearX = side < 0 ? 0 : w;
    const farX = vx + side * far;
    g.fillStyle = "#08081a";
    g.beginPath();
    g.moveTo(nearX, -h * 0.1);
    g.lineTo(farX, hy - h * 0.2);
    g.lineTo(farX, hy);
    g.lineTo(nearX, h);
    g.closePath();
    g.fill();
    // Signs, near ones big, receding toward the end of the alley.
    for (let i = 0; i < 5; i++) {
      const t = i / 5 + 0.04;
      const s = Math.pow(1 - t, 1.25);
      const x = nearX + (farX - nearX) * t;
      const [text, color] = SIGNS[(i * 2 + (side > 0 ? 1 : 0)) % SIGNS.length];
      const bw = 46 * k * s + 6 * k;
      const chars = [...text];
      const bh = (chars.length * 40 + 22) * k * s + 10 * k;
      const top = hy - h * 0.2 * (1 - t) - bh * 0.25 - (i % 2) * 40 * k * s - (1 - t) * h * 0.18;
      const left = side < 0 ? x + 6 * k * s : x - bw - 6 * k * s;
      g.fillStyle = "#0c0716";
      g.fillRect(left, top, bw, bh);
      glow(g, color, 18 * k * s + 4, () => {
        g.strokeStyle = color;
        g.lineWidth = Math.max(1, 2.2 * k * s);
        g.strokeRect(left, top, bw, bh);
        g.fillStyle = color;
        g.font = `700 ${Math.max(6, 32 * k * s)}px ${FONT}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        chars.forEach((ch, j) => g.fillText(ch, left + bw / 2, top + (j + 0.5) * (bh / chars.length)));
      });
    }
    // Lanterns along the eaves.
    for (let i = 0; i < 6; i++) {
      const t = i / 6 + 0.08;
      const s = Math.pow(1 - t, 1.2);
      const x = nearX + (farX - nearX) * t + side * -18 * k * s;
      const y = hy - h * 0.2 - (1 - t) * h * 0.08 + 4 * k;
      const r = Math.max(1.5, 13 * k * s);
      glow(g, "#ff5a3c", r * 2.4, () => {
        const lamp = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r * 1.3);
        lamp.addColorStop(0, "#ffd0a0");
        lamp.addColorStop(0.45, "#ff5a3c");
        lamp.addColorStop(1, "#7a1420");
        g.fillStyle = lamp;
        g.beginPath();
        g.ellipse(x, y, r, r * 1.25, 0, 0, Math.PI * 2);
        g.fill();
      });
    }
  }

  // Overhead wires.
  g.strokeStyle = "rgba(10, 10, 24, 0.9)";
  g.lineWidth = Math.max(1, 1.4 * k);
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(0, h * (0.06 + i * 0.07));
    g.quadraticCurveTo(vx, h * (0.16 + i * 0.07), w, h * (0.04 + i * 0.08));
    g.stroke();
  }

  // The street: wet asphalt, the shader lays the reflections over it.
  const street = g.createLinearGradient(0, hy, 0, h);
  street.addColorStop(0, "#0d0b1e");
  street.addColorStop(1, "#05050c");
  g.fillStyle = street;
  g.beginPath();
  g.moveTo(vx - far, hy);
  g.lineTo(vx + far, hy);
  g.lineTo(w, h);
  g.lineTo(0, h);
  g.closePath();
  g.fill();
}

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uT, uFlow, uLaneX, uLaneW;
uniform sampler2D uTex;
uniform vec3 uRain, uWet;
float h1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec3 tex(vec2 p) { return texture2D(uTex, clamp(p / uSize, 0.0, 1.0)).rgb; }
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  float hy = uSize.y * 0.6;
  float lane = (1.0 - smoothstep(uLaneW * 0.6, uLaneW, abs(px.x - uLaneX)));
  vec3 col = tex(px);
  float depth = (px.y - hy) / (uSize.y - hy);
  // The street runs between the walls' feet, which the painting draws to the screen's bottom corners.
  float far = 150.0 * clamp(uSize.y / 860.0, 0.45, 1.3);
  float street = depth > 0.0 ? (1.0 - smoothstep(-1.5, 1.5, abs(px.x - uSize.x * 0.5) - mix(far, uSize.x * 0.5, depth))) : 0.0;
  if (street > 0.0) {
    float wob = sin(px.y * 0.35 + uT * 6.2831853 * 0.5) * 1.6 * (1.0 - depth * 0.5);
    float my = hy - (px.y - hy) * 0.55;
    vec3 refl = (tex(vec2(px.x + wob, my)) + tex(vec2(px.x - wob, my - 10.0)) + tex(vec2(px.x + wob * 0.5, my - 22.0))) / 3.0;
    col += (refl * (0.55 - depth * 0.25) + uWet * 0.04) * street;
    // Ripples where drops land.
    vec2 g = px / vec2(46.0, 18.0);
    vec2 cell = floor(g);
    float hs = h1(mod(cell, 64.0));
    if (hs > 0.55) {
      float age = fract(hs * 5.0 + uT * 0.5);
      vec2 o = (fract(g) - 0.5) * vec2(46.0, 18.0) / vec2(1.0, 0.38);
      float rr = length(o);
      col += uRain * (1.0 - smoothstep(0.0, 1.4, abs(rr - age * 18.0))) * (1.0 - age) * 0.28 * depth * street;
    }
  }
  float rain = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float cw = 7.0 + fi * 5.0;
    float len = 34.0 + fi * 26.0;
    vec2 p = vec2(px.x + px.y * 0.1, px.y);
    float c = floor(p.x / cw);
    float hs = h1(vec2(c, fi * 11.0));
    float y = fract(p.y / len + uT * (1.5 + fi * 0.5) + hs * 9.0);
    float on = smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.1, 0.42 + hs * 0.2, y));
    float w = abs(fract(p.x / cw) - 0.3 - hs * 0.4) * cw;
    rain += on * (1.0 - smoothstep(0.0, 0.55 + fi * 0.25, w)) * step(0.5, hs) * (0.16 + fi * 0.1);
  }
  vec3 lit = uRain + tex(px) * 1.8;
  col += lit * rain * mix(0.45, 1.0, uFlow);
  col *= mix(1.0, 0.55, lane);
  gl_FragColor = vec4(col, 1.0);
}`;

export default flowScene({
  frag: FRAG,
  colors: { uRain: "#8ea6d8", uWet: "#2a2a60" },
  period: 60,
  backdrop: paint,
});
