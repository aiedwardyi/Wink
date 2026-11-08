// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");

function rule(open: string) {
  const start = css.indexOf(open);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  return { selector: css.slice(start, css.indexOf("{", start)).replace(/\s+/g, " ").trim(), body: css.slice(css.indexOf("{", start) + 1, end) };
}

function message(skin: string, who: "bot" | "user") {
  const host = document.body.appendChild(document.createElement("div"));
  host.dataset.skin = skin;
  host.innerHTML = `<div data-orbit-message="${who}"><div data-orbit-message-body><div data-orbit-message-content></div><div data-message-reactions></div></div></div>`;
  return host.querySelector("[data-orbit-message-content]")!;
}

afterEach(() => document.body.replaceChildren());

describe("reaction chips in bubble-less skins", () => {
  it("reserves the row the chips pull up into", () => {
    const pull = rule("[data-orbit-message-body] > [data-message-reactions] {").body.match(/margin: -([\d.]+rem)/)![1];
    const reserve = rule(':is([data-skin="claude"]').body.match(/padding-bottom: ([\d.]+rem)/)![1];
    expect(reserve).toBe(pull);
  });

  it("targets bot replies in Claude and Notebook only", () => {
    const { selector } = rule(':is([data-skin="claude"]');
    expect(message("claude", "bot").matches(selector)).toBe(true);
    expect(message("notebook", "bot").matches(selector)).toBe(true);
    expect(message("claude", "user").matches(selector)).toBe(false);
    expect(message("precision", "bot").matches(selector)).toBe(false);
  });
});
