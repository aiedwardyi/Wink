import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The picker draws over the chat, so it takes the skin's own face. A family named here that the app does not bundle
// falls through to whatever the OS has (Segoe UI on Windows), and the picker stops matching the rest of Wink.
const GENERIC = new Set(["serif", "sans-serif", "monospace", "system-ui", "ui-sans-serif", "ui-monospace", "cursive", "fantasy", "math", "emoji"]);
const css = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const bundled = new Set([...css("src/styles.css").matchAll(/@font-face\s*\{[^}]*font-family:\s*["']?([^"';]+)["']?\s*;/g)].map(([, family]) => family.trim()));
const rules = [...css("src/components/ModelPicker.css").matchAll(/([^{};]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const families = rules.flatMap(({ selector, body }) => [...body.matchAll(/(?:^|;)\s*font-family:\s*([^;]+)/g)].map(([, value]) => ({ selector, value: value.trim() })));

it("draws the model picker in the skin's font", () => {
  expect(families.find(({ selector }) => selector === ".model-cross-dialog")?.value).toBe("var(--font-sans)");
});

it("names no font the app does not bundle in the model picker", () => {
  expect(bundled.has("Geist")).toBe(true);
  const missing = families.flatMap(({ selector, value }) => /^(var\(--font-[\w-]+\)|inherit)$/.test(value) ? [] : value.split(",")
    .map(name => name.trim().replace(/^["']|["']$/g, ""))
    .filter(name => !GENERIC.has(name) && !bundled.has(name))
    .map(name => `${selector}: ${name} is not bundled, use var(--font-sans)`));
  expect(missing).toEqual([]);
});
