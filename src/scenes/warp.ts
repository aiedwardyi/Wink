// Warp: a starfield that streaks toward the viewer while Wink works. Stars
// sit in angle bins, so a streak runs along its own bin and never needs a
// neighbor lookup.
import { flowScene } from "./flow";

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uT, uFlow, uLaneX, uLaneW;
uniform vec3 uSpace, uNebula, uDust, uStar, uWarm, uBlue;
float h1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec2 h2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  vec2 c = vec2(uSize.x * 0.5, uSize.y * 0.4);
  vec2 d = px - c;
  float r = length(d);
  float R = length(uSize) * 0.5;
  float lane = smoothstep(uLaneW, uLaneW * 0.6, abs(px.x - uLaneX));

  vec2 q = px / max(uSize.y, 300.0) * 3.0;
  float n = 0.5 + 0.25 * (sin(q.x * 1.3 + sin(q.y * 0.9 + 1.0) * 1.7) + sin(q.y * 1.7 + sin(q.x * 1.1 + 2.0) * 1.5));
  vec3 col = uSpace;
  col += uNebula * n * n * 0.5 * smoothstep(1.2, 0.2, r / R);
  col += uDust * (0.5 + 0.5 * sin(q.x * 0.7 - q.y * 1.9 + sin(q.x * 2.3))) * 0.14;
  col += uBlue * exp(-r * r / (R * R * 0.06)) * 0.16;
  col *= mix(1.0, 0.6, lane);

  float th = atan(d.y, d.x) / 6.2831853 + 0.5;
  vec3 tint = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float ph = fi / 6.0 - uT * 0.2;
    float z = fract(ph) * 0.94 + 0.06;
    float cyc = mod(floor(ph), 20.0);
    float bins = 150.0 + fi * 20.0;
    float ab = th * bins;
    float bi = floor(ab);
    vec2 seed = vec2(bi, fi * 13.0 + cyc * 7.0);
    float hs = h1(seed);
    if (hs < 0.5) continue;
    vec2 hh = h2(seed);
    float rho = R * 0.3 * mix(0.06, 1.0, hh.y);
    float rs = rho / z;
    float r0 = rho / (z + 0.003 + 0.1 * uFlow);
    float da = (ab - bi - 0.25 - 0.5 * hh.x) / bins * 6.2831853 * r;
    float dr = r < r0 ? r0 - r : max(r - rs, 0.0);
    float size = mix(0.45, 1.25, hs) * clamp(0.55 + 0.35 / z, 0.6, 2.6);
    float e = (da * da + dr * dr) / (size * size);
    float a = smoothstep(1.0, 0.82, z) * mix(0.5, 1.0, hs);
    float tail = r < rs ? mix(0.55, 1.0, clamp((r - r0) / max(rs - r0, 1.0), 0.0, 1.0)) : 1.0;
    float s = (exp(-e) + 0.2 * exp(-e * 0.12)) * a * tail;
    tint += s * (hs > 0.94 ? uWarm : (hs > 0.8 ? uBlue : uStar));
  }
  col += tint * mix(0.9, 0.4, lane);
  gl_FragColor = vec4(col, 1.0);
}`;

export default flowScene({
  frag: FRAG,
  colors: { uSpace: "#060714", uNebula: "#3a2f8f", uDust: "#1d3a6e", uStar: "#eef2ff", uWarm: "#ffd6a0", uBlue: "#8fb8ff" },
  period: 100,
  sharp: true,
});
