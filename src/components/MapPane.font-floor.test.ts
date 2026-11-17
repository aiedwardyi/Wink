import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const FLOOR = 11;
const sizes = (source: string) => [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]*)\{([^{}]*)\}/g)].flatMap(([, selector, body]) =>
  [...body.matchAll(/font(?:-size)?:\s*(?:[^;]*?\s)?(\d*\.?\d+)px/g)].map(match => ({ at: selector.trim(), px: Number(match[1]) })));

it("keeps every Map text style at 11px or larger", () => {
  const small = ["MapPane.css", "MapTree.css", "MapGitFlow.css"].flatMap(name => sizes(readFileSync(`src/components/${name}`, "utf8")).map(size => ({ ...size, name })))
    .filter(size => size.px > 0 && size.px < FLOOR).map(size => `${size.name} ${size.at}: ${size.px}px, use ${FLOOR}px or more`);
  expect(small).toEqual([]);
});

it("measures tree boxes with the fonts the Map draws, none under 11px", () => {
  const measured = [...readFileSync("src/components/MapTree.tsx", "utf8").matchAll(/\d+ (\d*\.?\d+)px \$\{(?:sans|mono)\}/g)].map(match => Number(match[1]));
  expect(measured.length).toBeGreaterThan(0);
  expect(measured.filter(px => px < FLOOR).map(px => `measurer font ${px}px, use ${FLOOR}px or more`)).toEqual([]);
});
