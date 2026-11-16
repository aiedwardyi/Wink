// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "VerifyDoc.css"), "utf8");

afterEach(() => { document.head.querySelector("[data-verify-doc-test]")?.remove(); document.body.innerHTML = ""; });

it.each([
  ["", "auto"],
  ["data-inline", "auto"],
  ["data-maximized", "contain"],
])("uses %s scroll boundaries with %s overscroll", (attributes, overscroll) => {
  const style = document.createElement("style");
  style.dataset.verifyDocTest = "";
  style.textContent = css;
  document.head.append(style);
  document.body.innerHTML = `<div class="verify-watch-frame" ${attributes}><div class="verify-doc-stage"></div></div>`;
  const stage = getComputedStyle(document.querySelector(".verify-doc-stage")!);
  expect(stage.getPropertyValue("overscroll-behavior")).toBe(overscroll);
  expect(stage.overflow).toBe("auto");
});
