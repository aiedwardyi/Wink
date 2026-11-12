import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((each) =>
  each.isDirectory() ? sheets(join(dir, each.name)) : each.name.endsWith(".css") ? [join(dir, each.name)] : []);

// Touch browsers keep :hover on the last tapped element, so a hover look stays lit until the next tap elsewhere.
const ungated = (css: string) => {
  const found: string[] = [];
  const stack: string[] = [];
  let text = "";
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (char === "{") {
      const prelude = text.trim();
      if (prelude.includes(":hover") && !prelude.startsWith("@") && !stack.some((each) => /\(\s*hover\s*:\s*hover\s*\)/.test(each))) found.push(prelude);
      stack.push(prelude);
      text = "";
    } else if (char === "}") { stack.pop(); text = ""; }
    else if (char === ";") text = "";
    else text += char;
  }
  return found;
};

it("hover looks apply only where the pointer can hover", () => {
  const found = ["src", "site"].flatMap((dir) => sheets(join(root, dir))).flatMap((file) => ungated(readFileSync(file, "utf8")).map((rule) => `${relative(root, file)}: ${rule}`));
  expect(found).toEqual([]);
});

it("the scanner flags a bare hover and passes a gated one", () => {
  expect(ungated(".a:hover { color: red; }")).toEqual([".a:hover"]);
  expect(ungated("@media (hover: hover) { .a:hover { color: red; } }")).toEqual([]);
  expect(ungated("@media (pointer: coarse) { .a:hover { color: red; } }")).toEqual([".a:hover"]);
});
