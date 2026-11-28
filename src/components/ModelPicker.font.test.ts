import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The picker draws over the chat, so it takes the skin's own face. A family named here that the app does not bundle
// falls through to whatever the OS has (Segoe UI on Windows), and the picker stops matching the rest of Wink.
const GENERIC = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-sans-serif", "ui-monospace", "cursive", "fantasy", "math", "emoji"]);
const css = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const bundled = new Set([...css("src/styles.css").matchAll(/@font-face\s*\{[^}]*font-family:\s*["']?([^"';]+)["']?\s*;/g)].map(([, family]) => family.trim()));
// Every picker stylesheet: the model picker, its style popover, the quick picker, and any picker added later.
const pickerCss = readdirSync("src/components").filter(name => /Picker.*\.css$/.test(name)).map(name => `src/components/${name}`);
const rules = (path: string) => [...css(path).matchAll(/([^{};]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
// `font-family: ...` and the `font: [style] size[/line] family` shorthand both name families.
const families = pickerCss.flatMap(path => rules(path).flatMap(({ selector, body }) => [
  ...[...body.matchAll(/(?:^|;)\s*font-family:\s*([^;]+)/g)].map(([, value]) => value.trim()),
  ...[...body.matchAll(/(?:^|;)\s*font:\s*(?:[\w.-]+\s+)*?[\d.]+(?:px|rem|em)(?:\/[\d.]+(?:px|rem|em)?)?\s+([^;]+)/g)].map(([, value]) => value.trim()),
].map(value => ({ path, selector, value }))));

it("draws the model picker in the skin's font", () => {
  expect(families.find(({ path, selector }) => path.endsWith("ModelPicker.css") && selector === ".model-cross-dialog")?.value).toBe("var(--font-sans)");
});

it("names no font the app does not bundle in any picker stylesheet", () => {
  expect(bundled.has("Geist")).toBe(true);
  expect(pickerCss).toEqual(expect.arrayContaining(["src/components/ModelPicker.css", "src/components/PickerStyleStrip.css", "src/components/QuickModelPicker.css"]));
  const missing = families.flatMap(({ path, selector, value }) => /^(var\(--[\w-]+\)|inherit)$/.test(value) ? [] : value.split(",")
    .map(name => name.trim().replace(/^["']|["']$/g, ""))
    .filter(name => !GENERIC.has(name) && !bundled.has(name))
    .map(name => `${path} ${selector}: ${name} is not bundled, use var(--font-sans)`));
  expect(missing).toEqual([]);
});
