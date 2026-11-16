import { describe, expect, it } from "vitest";

import { Stretch } from "./stretch";

const RATE = 24_000;
const tone = (hz: number, seconds: number) => Float32Array.from({ length: RATE * seconds }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE));
// Rising zero crossings per second: the pitch a listener hears.
function pitch(data: Float32Array): number {
  let rises = 0;
  for (let i = 1; i < data.length; i++) if (data[i - 1]! < 0 && data[i]! >= 0) rises += 1;
  return rises / (data.length / RATE);
}
function run(stretch: Stretch, input: Float32Array, chunk = 4_800): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += chunk) parts.push(stretch.push(input.subarray(i, i + chunk)));
  parts.push(stretch.end());
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("Stretch", () => {
  it.each([0.7, 0.8, 1.2, 1.3])("plays a %sx voice in 1/speed of the time at the same pitch", (speed) => {
    const out = run(new Stretch(speed), tone(180, 2));
    expect(out.length / RATE).toBeCloseTo(2 / speed, 1);
    expect(Math.abs(pitch(out) - 180) / 180).toBeLessThan(0.03);
  });

  it("passes speed 1 through untouched", () => {
    const input = tone(180, 1);
    expect(run(new Stretch(1), input)).toEqual(input);
  });

  it("restarts from a point in the turn at a new speed", () => {
    const stretch = new Stretch(1);
    stretch.push(tone(180, 1));
    const out = stretch.restart(RATE / 2, 1.25);
    const rest = stretch.end();
    expect((out.length + rest.length) / RATE).toBeCloseTo(0.5 / 1.25, 1);
  });
});
