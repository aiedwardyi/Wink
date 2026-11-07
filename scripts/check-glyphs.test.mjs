import { describe, expect, it } from "vitest";
import { checkGlyphs, glyphHits } from "./check-glyphs.mjs";

const check = (source) => glyphHits("src/components/Meter.tsx", source);

describe("UI shape glyph gate", () => {
  it.each([
    'const bar = "▰";',
    'const bar = "▱";',
    'const bar = "█";',
    'const bar = "\\u25b0";',
    'const bar = `used ${count} ▰`;',
    'const view = <span>│</span>;',
    'const view = <span title="▰" />;',
    'const view = <span>&#x25b0;</span>;',
  ])("rejects a shape in a UI string: %s", (source) => {
    expect(check(source)).toEqual([expect.objectContaining({ file: "src/components/Meter.tsx", line: 1 })]);
  });

  it("ignores comments, regexes and ordinary text", () => {
    expect(check('// ▰\n/* █ */ const border = /│/; const label = "Usage 42% →";')).toEqual([]);
  });

  it("checks static HTML and CSS while ignoring comments", () => {
    expect(glyphHits("site/index.html", '<!-- ▰ --><span>&#9648;</span>')).toHaveLength(1);
    expect(glyphHits("src/styles.css", '/* ▰ */ .meter::before { content: "█"; }')).toHaveLength(1);
  });

  it("fails the gate for a new UI file and extra uses in an allowlisted file", () => {
    expect(checkGlyphs(["src/Meter.tsx"], () => 'const bar = "▰";')).toHaveLength(1);
    expect(checkGlyphs(["electron/terminal-host.mjs"], () => 'const bar = "▰" + "▰";')).toHaveLength(1);
  });

  it("rejects the retired terminal meter exceptions", () => {
    expect(checkGlyphs(["src/lib/terminal-skin.ts"], () => 'const bar = "▰" + "▰";')).toHaveLength(2);
  });

  it("accepts the repository with only its explicit base exceptions", () => {
    expect(checkGlyphs()).toEqual([]);
  });
});
