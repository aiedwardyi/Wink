// Circuit: board traces around the chat, light running along them and along
// the chat's own edges while Wink works. Traces thin out under the transcript.
import { flowScene } from "./flow";

const FRAG = `
precision highp float;
uniform vec2 uSize, uBuf;
uniform float uT, uFlow, uLaneX, uLaneW;
uniform vec3 uBoard, uTrace, uLit, uPulse, uPad;
float h1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float line(float d, float w) { return (1.0 - smoothstep(w - 0.3, w + 0.7, d)); }
// One trace axis: runs along x in rows of G px. Returns trace, pad and pulse light.
vec3 runs(vec2 p, float G, float salt, float lane, float speed) {
  float row = floor(p.y / G);
  float len = G * (3.0 + floor(h1(vec2(row, salt)) * 7.0));
  float shift = h1(vec2(salt, row)) * len;
  float k = floor((p.x + shift) / len);
  float hs = h1(vec2(row + salt * 3.0, k));
  if (hs < mix(0.38, 0.86, lane)) return vec3(0.0);
  float x0 = k * len - shift + G * 0.5;
  float x1 = x0 + len - G;
  float y = row * G + G * 0.5;
  float dy = abs(p.y - y);
  float along = clamp(p.x, x0, x1);
  float tr = line(length(vec2(p.x - along, dy)), 0.6);
  float pad = min(length(p - vec2(x0, y)), length(p - vec2(x1, y)));
  float ring = line(abs(pad - 3.2), 0.9) + line(pad, 1.2);
  float pulse = 0.0;
  if (hs > 0.62) {
    float u = fract(hs * 7.0 + uT * speed * (hs > 0.8 ? 1.0 : -1.0));
    float pxp = mix(x0, x1, u);
    float dd = length(vec2(p.x - pxp, dy));
    pulse = exp(-dd * dd / 6.0) + 0.35 * exp(-dd * dd / 60.0) * line(dy, 1.5);
  }
  return vec3(tr, ring, pulse);
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y) * (uSize / uBuf);
  float lane = (1.0 - smoothstep(uLaneW * 0.6, uLaneW, abs(px.x - uLaneX)));
  vec3 col = uBoard * mix(1.0, 0.8, lane);
  col += uTrace * 0.05 * (step(fract(px.x / 6.0), 0.17) * step(fract(px.y / 6.0), 0.17));
  vec3 a = runs(px, 22.0, 1.7, lane, 0.2);
  vec3 b = runs(px.yx, 22.0, 5.3, max(lane, 0.25), 0.3);
  float tr = max(a.x, b.x);
  float pad = max(a.y, b.y);
  float pulse = a.z + b.z;
  float fade = mix(1.0, 0.32, lane);
  col += uTrace * tr * 0.55 * fade + uPad * pad * 0.6 * fade;
  col += uPulse * pulse * fade * 1.1;
  // The chat's own borders are traces too: its left edge to the bot list, its top to the header.
  float edge = min(px.x, px.y);
  float lit = exp(-edge / 1.1) + 0.35 * exp(-edge / 9.0);
  float u = px.x < px.y ? px.y : uSize.y + px.x;
  float run = fract(u / 700.0 - uT * 0.5);
  float spark = exp(-pow((run - 0.5) * 700.0, 2.0) / 900.0);
  col += uLit * lit * (0.7 + 1.6 * spark);
  gl_FragColor = vec4(col, 1.0);
}`;

export default flowScene({
  frag: FRAG,
  colors: { uBoard: "#08111f", uTrace: "#1f6fd6", uLit: "#2f9bff", uPulse: "#7fe7ff", uPad: "#2a7fe0" },
  period: 100,
  sharp: true,
});
