import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Wink's motion rules: one arrow rule, every collapse and expand on IBM Carbon's
// productive motion (src/motion.css), the terminal instant, reduced motion instant.
const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => (existsSync(join(src, path)) ? readFileSync(join(src, path), "utf8") : "");
const motionCss = read("motion.css");
const styles = read("styles.css");
const theme = motionCss.match(/@theme static \{([^}]*)\}/)?.[1] ?? "";
const token = (name: string) => theme.match(new RegExp(`--${name}: ([^;]+);`))?.[1];
const rule = (selector: string) => motionCss.match(new RegExp(`(?:^|\\n)${selector.replace(/[[\]()*.]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

describe("shared motion tokens", () => {
  it("ports Carbon's productive motion as six tokens that every bare transition uses", () => {
    expect(styles).toContain('@import "./motion.css";');
    // @carbon/motion 11.55.0: duration-fast-02, moderate-01, moderate-02 and the productive curves
    expect(token("motion-fast")).toBe("110ms");
    expect(token("motion-moderate")).toBe("150ms");
    expect(token("motion-large")).toBe("240ms");
    expect(token("ease-standard")).toBe("cubic-bezier(0.2, 0, 0.38, 0.9)");
    expect(token("ease-entrance")).toBe("cubic-bezier(0, 0, 0.38, 0.9)");
    expect(token("ease-exit")).toBe("cubic-bezier(0.2, 0, 1, 0.9)");
    expect(token("default-transition-duration")).toBe("var(--motion-fast)");
    expect(token("default-transition-timing-function")).toBe("var(--ease-standard)");
  });

  it("times every surface by the tokens alone, with no number of its own", () => {
    expect(theme.match(/\d+ms/g)).toEqual(["110ms", "150ms", "240ms"]);
    for (const name of ["panel-in", "pop-in", "fade-in"]) expect(token(`animate-${name}`)).toBe(`${name} var(--motion-moderate) var(--ease-entrance)`);
    expect(token("animate-tip-in")).toBe("tip-in var(--motion-fast) var(--ease-entrance)");
    const rules = motionCss.replace(/@theme static \{[^}]*\}/, "").replace(/\/\*[\s\S]*?\*\//g, "");
    // the only literal durations left are the reduced-motion zeros
    expect(rules.match(/\b\d*\.?\d+m?s\b/g)).toEqual(["0s", "0s", "0s"]);
    expect(rules).not.toContain("cubic-bezier(");
  });

  it("drives script motion from the same tokens", async () => {
    const motion = await import("./motion");
    const { PRESENCE_EXIT_MS } = await import("./use-presence");
    expect(`${motion.MOTION_FAST_MS}ms`).toBe(token("motion-fast"));
    expect(`${motion.MOTION_MODERATE_MS}ms`).toBe(token("motion-moderate"));
    expect(`${motion.MOTION_LARGE_MS}ms`).toBe(token("motion-large"));
    expect(motion.EASE_STANDARD).toBe(token("ease-standard"));
    expect(motion.EASE_ENTRANCE).toBe(token("ease-entrance"));
    expect(motion.EASE_SOFT).toBe(token("ease-soft"));
    expect(PRESENCE_EXIT_MS).toBe(motion.MOTION_FAST_MS);
  });

  it("keeps the swipe follow-through on its own spring, carrying the finger's speed", async () => {
    const { SWIPE_MOTION_MS, SWIPE_SPRING } = await import("./phone-swipe");
    expect(SWIPE_MOTION_MS).toBe(260);
    expect(SWIPE_SPRING).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("makes everything instant under reduced motion", () => {
    const reduce = motionCss.match(/@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/)?.[1] ?? "";
    expect(reduce.match(/--[\w-]+: 0s;/g)).toEqual(["--motion-fast: 0s;", "--motion-moderate: 0s;", "--motion-large: 0s;"]);
  });
});

describe("collapse and expand", () => {
  it("opens and closes the terminal instantly, with no motion", () => {
    const overlay = styles.match(/\.orbit-terminal-overlay \{[^}]*\}\s*\.orbit-terminal-overlay\[data-open="true"\] \{[^}]*\}/)?.[0] ?? "";
    expect(overlay).toContain("translateX(0)");
    expect(overlay).not.toMatch(/transition|animation/);
    expect(styles).not.toContain("terminal-enter");
  });

  it("slides a closing side panel out toward its edge while the chat takes its width back at once", () => {
    expect(rule("[data-side-panel][data-closing]")).toContain("animation-name: panel-out;");
    expect(motionCss).toMatch(/@keyframes panel-out \{\s*to \{ transform: translateX\(28px\); opacity: 0; \}/);
    expect(rule("[data-closing]")).toContain("fade-out var(--motion-fast) var(--ease-exit) forwards");
    expect(styles).not.toMatch(/\[data-settings-panel\]\[data-closing\] \{\s*display: none/);
    expect(read("components/SettingsPanel.tsx")).toMatch(/<aside [^>]*data-side-panel=""[^>]*md:data-closing:-ml-\[400px\]/);
    expect(read("components/InspectorPanel.tsx")).toMatch(/<aside [^>]*data-side-panel=""[^>]*data-closing:-ml-\[460px\]/);
  });

  it("folds by the grid track on the tokens, clipping only while it moves", () => {
    expect(rule("[data-fold]")).toContain("grid-template-rows: 1fr;");
    expect(rule("[data-fold] > *")).toContain("min-height: 0;");
    expect(rule('[data-fold="opening"]')).toContain("fold-open var(--motion-moderate) var(--ease-standard)");
    expect(rule('[data-fold="closing"]')).toContain("fold-close var(--motion-fast) var(--ease-standard) forwards");
    expect(rule('[data-fold="closing"]')).toContain("pointer-events: none;");
    expect(motionCss).not.toMatch(/\[data-fold\] > \* \{[^}]*overflow/);
  });

  it.each([
    "ActivityRun", "ChatView", "EngineConnect", "EnginesSettings", "InspectorPanel", "MemoryMap",
    "MemorySaveChip", "PhoneLinkSettings", "SettingsModal", "SettingsPanel", "SkinPicker", "WorkerRows",
  ])("folds %s's disclosure content instead of snapping it", (name) => {
    expect(read(`components/${name}.tsx`)).toMatch(/<Fold open=\{/);
  });
});

describe("one arrow rule", () => {
  it("points Bot Details' collapse right, toward the edge the panel leaves by", () => {
    const panel = read("components/SettingsPanel.tsx");
    const at = panel.indexOf('aria-label={t("bot.collapseDetails")}');
    expect(at).toBeGreaterThan(-1);
    const button = panel.slice(at, panel.indexOf("</button>", at));
    expect(button).toContain("<ChevronRight ");
    expect(button).not.toContain("<ChevronLeft");
  });

  // Carbon: a fold's chevron points down while closed and turns up when open; right is for going somewhere.
  it.each([
    "ActivityRun", "ChatView", "InspectorPanel", "MemoryGroups", "MemorySaveChip", "ModelPicker",
    "SettingsModal", "SidebarSectionHeader", "SkinPicker", "WorkerRows",
  ])("turns %s's fold chevron down to up", (name) => {
    const source = read(`components/${name}.tsx`);
    expect(source).toMatch(/<ChevronDown[^>]*rotate-180/);
    expect(source).not.toContain("rotate-90");
  });
});
