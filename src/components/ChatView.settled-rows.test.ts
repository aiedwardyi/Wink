import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const declaring = (property: string) => rules.filter((rule) => new RegExp(`(^|;|\\s)${property}:`).test(rule.body));

describe("settled transcript rows", () => {
  it("skips only settled rows", () => {
    expect(declaring("content-visibility").map((rule) => rule.selector)).toEqual([
      "[data-orbit-transcript] [data-settled] > *",
      "[data-orbit-transcript] [data-settled][data-landing] > *",
    ]);
  });

  it("remembers the newest row's size before it settles", () => {
    const sized = declaring("contain-intrinsic-block-size");
    expect(sized).toHaveLength(1);
    expect(sized[0]!.body).toMatch(/contain-intrinsic-block-size:\s*auto\s/);
    for (const row of ["[data-mid]", "[data-run]", "[data-settled]"]) expect(sized[0]!.selector).toContain(row);
  });
});
