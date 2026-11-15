// Samurai Ink: a swordsman on a ridge against the moon, in black and white.
// The ink painting is drawn once per size; the shader adds what the wind moves:
// his hair and sash, falling leaves, wind strokes and, while Wink works, a
// sword swipe every few seconds.
import { flowScene } from "./flow";

// Shared with the shader: where he stands and how big a figure unit is.
const FIGURE = `
vec3 figure(vec2 size) {
  float u = size.y * 0.0042;
  return vec3(max(size.x * 0.5, min(size.x * 0.8, size.x - size.y * 0.2)), size.y * 0.78, u);
}`;

function figure(w: number, h: number) {
  const u = h * 0.0042;
  return { x: Math.max(w * 0.5, Math.min(w * 0.8, w - h * 0.2)), y: h * 0.78, u };
}

function paint(g: CanvasRenderingContext2D, w: number, h: number) {
  const f = figure(w, h);
  const P = (x: number, y: number): [number, number] => [f.x + x * f.u, f.y + y * f.u];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#070707");
  sky.addColorStop(0.7, "#141414");
  sky.addColorStop(1, "#0b0b0b");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  // The moon, a wash with a few darker blooms in it.
  const mx = f.x + h * 0.04;
  const my = h * 0.36;
  const mr = h * 0.17;
  const halo = g.createRadialGradient(mx, my, mr * 0.9, mx, my, mr * 2.4);
  halo.addColorStop(0, "rgba(200, 198, 190, 0.16)");
  halo.addColorStop(1, "rgba(200, 198, 190, 0)");
  g.fillStyle = halo;
  g.fillRect(0, 0, w, h);
  const moon = g.createRadialGradient(mx - mr * 0.3, my - mr * 0.3, 0, mx, my, mr);
  moon.addColorStop(0, "#c9c6bd");
  moon.addColorStop(1, "#a7a49b");
  g.fillStyle = moon;
  g.beginPath();
  g.arc(mx, my, mr, 0, Math.PI * 2);
  g.fill();
  g.save();
  g.clip();
  for (let i = 0; i < 7; i++) {
    const bx = mx + (rnd() - 0.5) * mr * 1.4;
    const by = my + (rnd() - 0.5) * mr * 1.4;
    const br = mr * (0.12 + rnd() * 0.25);
    const bloom = g.createRadialGradient(bx, by, 0, bx, by, br);
    bloom.addColorStop(0, "rgba(120, 118, 110, 0.22)");
    bloom.addColorStop(1, "rgba(120, 118, 110, 0)");
    g.fillStyle = bloom;
    g.fillRect(bx - br, by - br, br * 2, br * 2);
  }
  g.restore();

  // Ink-wash ridges, far and pale to near and dark, each fading into mist.
  const ridges = [
    { y: 0.62, amp: 0.1, tone: "38, 38, 40", step: 0.05 },
    { y: 0.7, amp: 0.08, tone: "26, 26, 28", step: 0.035 },
    { y: 0.8, amp: 0.06, tone: "16, 16, 17", step: 0.025 },
  ];
  for (const r of ridges) {
    const top = h * (r.y - r.amp);
    const mist = g.createLinearGradient(0, top, 0, h * (r.y + 0.14));
    mist.addColorStop(0, `rgba(${r.tone}, 1)`);
    mist.addColorStop(1, `rgba(${r.tone}, 0)`);
    g.fillStyle = mist;
    g.beginPath();
    g.moveTo(0, h);
    let y = h * r.y;
    for (let x = 0; x <= w + 8; x += w * r.step) {
      y = Math.max(top, Math.min(h * (r.y + 0.02), y + (rnd() - 0.55) * h * r.amp * 0.8));
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  }

  // The ridge he stands on.
  g.fillStyle = "#040404";
  g.beginPath();
  g.moveTo(f.x - 70 * f.u, h);
  g.quadraticCurveTo(f.x - 40 * f.u, f.y + 4 * f.u, f.x - 12 * f.u, f.y);
  g.lineTo(f.x + 30 * f.u, f.y - 1 * f.u);
  g.quadraticCurveTo(f.x + 70 * f.u, f.y + 3 * f.u, w + 4, f.y + 10 * f.u);
  g.lineTo(w + 4, h);
  g.closePath();
  g.fill();
  // Grass bent by the wind.
  g.strokeStyle = "#040404";
  g.lineWidth = Math.max(0.8, f.u * 0.7);
  for (let i = 0; i < 26; i++) {
    const gx = f.x + (-36 + rnd() * 90) * f.u;
    const gy = f.y + rnd() * 2 * f.u;
    const len = (5 + rnd() * 9) * f.u;
    g.beginPath();
    g.moveTo(gx, gy);
    g.quadraticCurveTo(gx - len * 0.2, gy - len * 0.7, gx - len * 0.8, gy - len * 0.85);
    g.stroke();
  }

  // The swordsman, facing into the wind: hakama, haori with its sleeve blown back, the drawn blade low at his right.
  const ink = "#030303";
  g.fillStyle = ink;
  const poly = (pts: [number, number][]) => {
    g.beginPath();
    g.moveTo(...P(...pts[0]));
    for (const p of pts.slice(1)) g.lineTo(...P(...p));
    g.closePath();
    g.fill();
  };
  poly([[-8, -50], [8, -50], [12, -24], [17, -1], [6, 0], [1, -18], [-4, 0], [-22, 0], [-31, -4], [-20, -10], [-13, -28]]);
  poly([[-9, -52], [9, -52], [13, -66], [15, -80], [6, -84], [-6, -84], [-14, -80], [-13, -66]]);
  // Sleeve blown back, the right arm forward to the hilt.
  poly([[-13, -79], [-26, -74], [-37, -62], [-31, -58], [-22, -60], [-12, -63]]);
  poly([[12, -78], [19, -68], [22, -56], [18, -52], [14, -60], [9, -68]]);
  // Head and the hair gathered at the nape.
  g.beginPath();
  g.ellipse(...P(-1, -90), 5.6 * f.u, 6.6 * f.u, 0.15, 0, Math.PI * 2);
  g.fill();
  poly([[-6, -95], [2, -97], [3, -91], [-3, -86], [-9, -88]]);
  // The katana: a slight curve down and out from his hand, its edge catching the moon.
  const blade = (dx: number, dy: number) => P(19 + dx, -53 + dy);
  g.beginPath();
  g.moveTo(...blade(0, 0));
  g.quadraticCurveTo(...blade(20, 10), ...blade(44, 30));
  g.quadraticCurveTo(...blade(21, 13), ...blade(-1, 2));
  g.closePath();
  g.fill();
  g.strokeStyle = "rgba(235, 232, 224, 0.85)";
  g.lineWidth = Math.max(0.6, f.u * 0.45);
  g.beginPath();
  g.moveTo(...blade(4, 2.6));
  g.quadraticCurveTo(...blade(22, 12.4), ...blade(43, 29.6));
  g.stroke();
  // Tsuka and tsuba.
  g.lineWidth = Math.max(1, f.u * 2.2);
  g.strokeStyle = ink;
  g.beginPath();
  g.moveTo(...P(13, -58));
  g.lineTo(...blade(1, 1));
  g.stroke();
  g.beginPath();
  g.ellipse(...blade(0.5, 0.5), 2.4 * f.u, 1 * f.u, 0.6, 0, Math.PI * 2);
  g.fill();
  // The saya at his left hip, pointing back.
  g.lineWidth = Math.max(1, f.u * 1.6);
  g.beginPath();
  g.moveTo(...P(-6, -50));
  g.lineTo(...P(24, -40));
  g.stroke();
}

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uT, uFlow, uLaneX, uLaneW;
uniform sampler2D uTex;
uniform vec3 uInk, uPaper, uSlash;
${FIGURE}
float h1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
const float TAU = 6.2831853;
// A ribbon streaming left from a, length L, thickness w0 at the root.
float ribbon(vec2 p, vec2 a, float L, float w0, float lift, float ph, float u) {
  float s = (a.x - p.x) / L;
  if (s < 0.0 || s > 1.0) return 0.0;
  float y = a.y - lift * s * s * L + sin(s * 7.0 - uT * TAU * 0.75 + ph) * s * 3.2 * u + sin(s * 13.0 - uT * TAU * 1.25 + ph * 2.0) * s * 1.1 * u;
  float w = mix(w0, 0.25 * u, pow(s, 0.8));
  return (1.0 - smoothstep(w - 0.4, w + 0.8, abs(p.y - y)));
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  float lane = (1.0 - smoothstep(uLaneW * 0.6, uLaneW, abs(px.x - uLaneX)));
  vec3 col = texture2D(uTex, px / uSize).rgb;
  vec3 f = figure(uSize);
  float u = f.z;
  vec2 o = vec2(f.x, f.y);
  float hair = ribbon(px, o + vec2(-6.0, -92.0) * u, 40.0 * u, 3.4 * u, -0.05, 0.0, u);
  hair = max(hair, ribbon(px, o + vec2(-7.0, -89.0) * u, 33.0 * u, 2.4 * u, -0.12, 1.3, u));
  hair = max(hair, ribbon(px, o + vec2(-5.0, -94.0) * u, 26.0 * u, 1.6 * u, 0.12, 2.1, u));
  float sash = ribbon(px, o + vec2(-10.0, -51.0) * u, 24.0 * u, 1.6 * u, -0.04, 0.7, u);
  sash = max(sash, ribbon(px, o + vec2(-10.0, -49.0) * u, 18.0 * u, 1.2 * u, -0.18, 2.4, u));
  col = mix(col, uInk, max(hair, sash));

  // Wind strokes: long faint brush lines sweeping left.
  float row = floor(px.y / 48.0);
  float hr = h1(vec2(row, 3.0));
  if (hr > 0.6) {
    float x = fract(px.x / 1100.0 + uT * (0.5 + floor(hr * 3.0) * 0.25) + hr * 5.0);
    float bow = sin(x * 3.14159) * 7.0;
    float y = abs(fract(px.y / 48.0) - 0.5) * 48.0 - bow + 3.5;
    float body = smoothstep(0.0, 0.05, x) * (1.0 - smoothstep(0.02, 0.24, x));
    float stroke = body * (1.0 - smoothstep(0.0, 0.4 + 1.6 * body, abs(y)));
    col += uPaper * stroke * mix(0.07, 0.16, uFlow);
  }

  // Leaves on the wind, near ones big and fast, far ones small.
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float cs = 66.0 + fi * 44.0;
    float vx = (fi > 0.5 ? 220.0 : 110.0);
    vec2 p = px + vec2(uT * vx, -uT * vx * 0.5);
    p.y += sin(px.x / 140.0 + uT * TAU * 0.25 + fi) * 14.0;
    vec2 cell = floor(p / cs);
    vec2 key = mod(cell, vec2(120.0 * vx / cs, 60.0 * vx / cs));
    float hs = h1(key + fi * 17.0);
    if (hs < 0.72) continue;
    vec2 at = (cell + 0.3 + 0.4 * vec2(h1(key + 3.7), h1(key + 9.1))) * cs;
    float ang = hs * TAU + uT * TAU * floor(hs * 3.0 + 1.0) / 4.0;
    vec2 q = p - at;
    q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;
    float sz = (4.5 + fi * 3.5) * (0.7 + hs * 0.5) * max(0.55, uSize.y / 860.0);
    // Two arcs meeting in points: a leaf, not a petal.
    float u2 = q.x / sz;
    float m = (1.0 - smoothstep(-0.5, 0.7, abs(q.y) - sz * 0.38 * (1.0 - u2 * u2))) * step(abs(u2), 1.0);
    float bg = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, bg > 0.45 ? uInk : uPaper * (0.62 + 0.25 * fi), m * 0.92);
  }

  // A swipe: a thin crescent that flashes past him every few seconds while Wink works.
  float ph = fract(uT / 4.0);
  if (uFlow > 0.05 && ph < 0.16) {
    float k = ph / 0.16;
    vec2 c = o + vec2(-6.0, -60.0) * u;
    vec2 d = px - c;
    float R = 46.0 * u;
    float a = atan(-d.y, -d.x);
    float head = mix(-0.9, 2.6, k);
    float along = head - a;
    float arc = smoothstep(0.0, 0.04, along) * (1.0 - smoothstep(0.0, 1.5, along));
    float w = (1.0 + 2.4 * (1.0 - smoothstep(0.0, 1.5, along))) * u;
    float edge = (1.0 - smoothstep(w * 0.2, w + 1.0, abs(length(d) - R)));
    col = mix(col, uSlash, edge * arc * (1.0 - k * k) * uFlow);
  }
  col *= mix(1.0, 0.6, lane);
  gl_FragColor = vec4(col, 1.0);
}`;

export default flowScene({
  frag: FRAG,
  colors: { uInk: "#030303", uPaper: "#e8e5dd", uSlash: "#f6f4ee" },
  period: 120,
  backdrop: paint,
});
