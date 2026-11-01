import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./mono-hud.css", import.meta.url), "utf8");

function declarations(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

function pixels(body: string, property: string): number {
  const value = body.match(new RegExp(`\\b${property}: ([\\d.]+)px;`));
  expect(value, property).not.toBeNull();
  return Number(value![1]);
}

describe("Servo composer gauge", () => {
  it("aligns both strip bounds with the composer's chamfer", () => {
    const radius = pixels(declarations("[data-orbit-composer-frame]"), "border-radius");
    const strip = declarations("[data-orbit-composer-frame]::after");
    expect(pixels(strip, "left")).toBeCloseTo(radius, 1);
    expect(pixels(strip, "right")).toBeCloseTo(radius, 1);
  });
});
