import { describe, expect, it } from "vitest";
import { iconInk, sceneIconProblems } from "../scripts/check-skin-contrast.mjs";

const MENU = "[data-phone-menu]";
const SCENE = ":is(:has(~ main[data-scene][data-scene-painted]), :has(~ * main[data-scene][data-scene-painted]))";
const TOKENS = { "--color-ink-secondary": "#b3b0a8", "--color-accent": "#e8e4dc", "--color-accent-ink": "#0c0c0d", "--color-app": "#0c0c0d", "--color-panel": "#070707" };
const STILLS = new Map([["samurai-ink", "samurai-ink.jpg"]]);
const MOON = { menu: "#bab1a5", toggle: "#ece1d1", dot: "#e0d6c6" };
const NIGHT = { menu: "#010101", toggle: "#010101", dot: "#010101" };
const row = (spots) => ({ 360: spots, 390: spots });
const BACKDROPS = { "samurai-ink": { left: row(NIGHT), right: row(MOON) } };
const rule = (selector, body) => `${selector} { ${body} }`;
const darkMenu = rule(`[data-skin="samurai-ink"] ${MENU}[data-side="right"]${SCENE}`, "color: var(--color-accent-ink);");

describe("iconInk follows the cascade and the state a rule needs", () => {
  const base = `[data-skin="samurai-ink"] ${MENU}`;
  it("lets a side-specific rule beat a later general one, and the later of equals win", () => {
    const css = [rule(base, "color: var(--color-a);"), rule(`${base}[data-side="right"]`, "color: var(--color-b);"), rule(base, "color: var(--color-c);")].join("\n");
    expect(iconInk(css, MENU, "samurai-ink", "left")).toBe("--color-c");
    expect(iconInk(css, MENU, "samurai-ink", "right")).toBe("--color-b");
  });

  it("skips a rule that needs a painted scene or a closed terminal when the state lacks it", () => {
    const css = rule(`${base}[data-side="right"]:not([data-terminal-covers])${SCENE}`, "color: var(--color-accent-ink);");
    expect(iconInk(css, MENU, "samurai-ink", "right")).toBe("--color-accent-ink");
    expect(iconInk(css, MENU, "samurai-ink", "right", "color", { painted: false, covers: false })).toBeNull();
    expect(iconInk(css, MENU, "samurai-ink", "right", "color", { painted: true, covers: true })).toBeNull();
  });

  it("refuses a condition it cannot evaluate", () => {
    const css = rule(`${base}[aria-expanded="true"]`, "color: var(--color-accent-ink);");
    expect(() => iconInk(css, MENU, "samurai-ink", "right")).toThrow(/cannot evaluate/);
  });
});

describe("sceneIconProblems", () => {
  const problems = (css, icon, backdrops = BACKDROPS) => [...new Set(sceneIconProblems("samurai-ink", TOKENS, STILLS, css, backdrops).map((p) => p.icon).filter((name) => name.startsWith(icon)))];

  it("passes dark menu ink that shows only on a painted scene with no terminal over it", () => {
    const css = darkMenu.replace(`[data-side="right"]`, `[data-side="right"]:not([data-terminal-covers])`);
    expect(problems(css, "phone menu")).toEqual([]);
  });

  it("fails dark menu ink that stays on over the phone terminal and the unpainted fallback", () => {
    expect(problems(darkMenu.replaceAll("[data-scene-painted]", ""), "phone menu")).toEqual(["phone menu (drawer right, scene not painted)", "phone menu (drawer right, terminal open)"]);
  });

  it("fails a cream unread dot on the moon until a rule darkens it", () => {
    expect(problems("", "unread dot")).toEqual(["unread dot (drawer right, scene)"]);
    const dark = rule(`[data-skin="samurai-ink"] [data-side="right"]:not([data-terminal-covers])${SCENE} > [data-menu-unread]`, "background-color: var(--color-accent-ink);");
    expect(problems(dark, "unread dot")).toEqual([]);
  });

  it("fails when a drawer side or a phone width was never measured", () => {
    const { right } = BACKDROPS["samurai-ink"];
    expect(() => problems("", "phone menu", { "samurai-ink": { left: row(NIGHT) } })).toThrow(/drawer right, 360px/);
    expect(() => problems("", "phone menu", { "samurai-ink": { left: row(NIGHT), right: { 360: MOON } } })).toThrow(/drawer right, 390px/);
    expect(() => problems("", "phone menu", { "samurai-ink": { left: row(NIGHT), right: { ...right, 390: { toggle: MOON.toggle } } } })).toThrow(/no menu backdrop/);
  });
});
