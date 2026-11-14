// The registry and the stylesheet are two halves of one contract: a skin listed
// here without a matching CSS block renders as whatever was active before, with
// no error anywhere. That failure is silent, so it gets a test.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { SKINS, SKIN_IDS, DEFAULT_SKIN, LIGHT_SKIN_IDS, applySkin, isTerminalSkin, isTerminalToolSkin, readSkin, readTriedSkins, type SkinId } from "./skins";
import { terminalTheme } from "./terminal-appearance";

const css = ["../styles.css", "../skins/fresh-dark.css"]
  .map((file) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8"))
  .join("\n")
  .replace(/\r\n/g, "\n");

const blocks = new Set(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]/g)].map(([, id]) => id),
);

function cssToken(id: string, name: string): string | null {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`))?.[1]?.toLowerCase() ?? null;
}

// A shared list (`[data-skin="a"],\n[data-skin="b"] {`) gives every listed skin its tokens.
function sharedBodies(id: string): string[] {
  return [...css.matchAll(/((?:\[data-skin="[a-z-]+"\],\s*)+\[data-skin="[a-z-]+"\])\s*\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.includes(`[data-skin="${id}"]`))
    .map(([, , body]) => body);
}

function tokensOf(id: string): Set<string> {
  const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return new Set([body, ...sharedBodies(id)].flatMap((b) => [...b.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name)));
}

function channels(hex: string) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function spread(hex: string) {
  const { r, g, b } = channels(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function luminance(hex: string) {
  const { r, g, b } = channels(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(hex1: string, hex2: string) {
  const [hi, lo] = [luminance(hex1), luminance(hex2)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// Model brightness-110 as each sRGB channel of both fill and ink times 1.1, capped at 255.
function brightness110(hex: string) {
  const { r, g, b } = channels(hex);
  const scale = (c: number) => Math.min(255, Math.round(c * 1.1));
  const hex2 = (c: number) => scale(c).toString(16).padStart(2, "0");
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function blend(fgHex: string, bgHex: string, alpha: number): string {
  const f = channels(fgHex);
  const b = channels(bgHex);
  const c = (vf: number, vb: number) =>
    Math.round(vf * alpha + vb * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${c(f.r, b.r)}${c(f.g, b.g)}${c(f.b, b.b)}`;
}

function skinToken(id: string, name: string): string {
  if (id === "default") {
    const rootBody = css.match(/(?:@theme|:root)\s*\{([^}]*)\}/)?.[1] ?? "";
    const match = rootBody.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`));
    if (match) return match[1].toLowerCase();
    throw new Error(`Token ${name} missing for skin ${id}`);
  }
  const token = cssToken(id, name);
  if (token) return token;
  const rootBody = css.match(/(?:@theme|:root)\s*\{([^}]*)\}/)?.[1] ?? "";
  const rootMatch = rootBody.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]+)`));
  if (rootMatch) return rootMatch[1].toLowerCase();
  throw new Error(`Token ${name} missing for skin ${id}`);
}

describe("skins", () => {
  it("insets Claude bot replies only when Boxy geometry is active", () => {
    expect(css).toMatch(
      /:root\[data-shape="boxy"\]\[data-skin="claude"\]\s+\[data-orbit-message="bot"\] \[data-orbit-message-content\]\s*\{\s*padding-left:\s*12px;/,
    );
    const claude = css.match(/\[data-skin="claude"\] \[data-orbit-message="bot"\] \[data-orbit-message-content\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(claude).toContain("padding: 0;");
  });

  it("insets all added bot replies when Boxy geometry is active", () => {
    const boxy = css.match(
      /:root\[data-shape="boxy"\]:is\(([\s\S]*?)\)\s*\[data-orbit-message="bot"\][^{]+\{([^}]*)\}/,
    )?.[0] ?? "";
    const ids = ["precision", "notebook", "messenger", "community", "community-light", "code-review", "blueprint", "blueprint-gray", "blueprint-charcoal"];
    for (const id of ids) {
      expect(boxy).toContain(`[data-skin="${id}"]`);
    }
    expect(boxy).toContain("padding-left: 12px;");

    const boxyIndex = css.indexOf("/* Keep the rail-to-glyph gap after skin-specific bot padding rules. */");
    expect(boxyIndex).toBeGreaterThan(-1);
    for (const id of ids) {
      expect(boxyIndex).toBeGreaterThan(css.indexOf(`[data-skin="${id}"]`));
    }
  });

  it("gives every registered skin a stylesheet block", () => {
    for (const id of SKIN_IDS) expect(blocks).toContain(id);
  });

  it("registers every stylesheet block", () => {
    const registered = new Set<string>(SKIN_IDS);
    for (const id of blocks) expect(registered).toContain(id);
  });

  it("defines the same tokens in every skin", () => {
    // Midnight is the shared set. Light skins add --color-syntax-* on top;
    // those must not become a requirement for dark skins.
    const reference = tokensOf("midnight");
    expect(reference.size).toBeGreaterThan(15);
    for (const id of SKIN_IDS) {
      expect([...reference].filter((t) => !tokensOf(id).has(t))).toEqual([]);
    }
  });

  it("gives light skins and VS Code Dark a syntax palette and leaves other dark skins alone", () => {
    const roles = [
      "--color-syntax-fg",
      "--color-syntax-comment",
      "--color-syntax-keyword",
      "--color-syntax-string",
      "--color-syntax-function",
      "--color-syntax-constant",
      "--color-syntax-variable",
      "--color-syntax-tag",
      "--color-syntax-invalid",
    ];
    const remapped = [
      "atelier",
      "lagoon",
      "ledger",
      "vscode-dark",
      "notebook",
      "messenger",
      "community-light",
      "code-review",
      "blueprint",
      "wink-day",
      "paper-tape",
      "dim-sand",
      "snow",
    ];
    for (const id of remapped) {
      expect([...tokensOf(id)]).toEqual(expect.arrayContaining(roles));
    }
    for (const id of SKIN_IDS) {
      if (remapped.includes(id)) continue;
      expect([...tokensOf(id)].filter((t) => t.startsWith("--color-syntax-"))).toEqual([]);
    }
  });

  it("drives native input color-scheme from the skin, not a hardcoded dark utility", () => {
    const rootBody = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rootBody).toMatch(/color-scheme:\s*dark\s*;/);
    const light = ["atelier", "lagoon", "ledger", "notebook", "messenger", "community-light", "code-review", "blueprint", "wink-day", "paper-tape", "dim-sand"];
    for (const id of light) {
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toMatch(/color-scheme:\s*light\s*;/);
    }
    const components = join(dirname(fileURLToPath(import.meta.url)), "../components");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (readFileSync(p, "utf8").includes("[color-scheme:dark]")) hits.push(p);
      }
    };
    walk(components);
    expect(hits).toEqual([]);
  });

  it("drives remapped syntax contrast from github-dark-default emitted foregrounds", () => {
    const check = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../scripts/check-skin-contrast.mjs"),
      "utf8",
    );
    expect(check).toContain("github-dark-default");
    expect(check).toContain("tokenColors");
    expect(check).toContain("emittedForegrounds");
    expect(check).toContain('"vscode-dark"');
    expect(check).not.toContain("SYNTAX_ROLES");
  });

  it("defaults a fresh install to Precision and does not rename Atelier", () => {
    expect(DEFAULT_SKIN).toBe("precision");
    expect(SKINS.some((s) => s.id === "atelier" && s.name === "Atelier")).toBe(true);
    expect(SKIN_IDS).not.toContain("letelier");
  });

  it("sets Precision in Space Grotesk with bubbles on both sides, wide, and no side line", () => {
    expect(css.match(/\[data-skin="precision"\]\s*\{([^}]*)\}/)![1]).toMatch(/--font-sans:\s*"Space Grotesk"/);
    expect(css).toMatch(/\[data-skin="precision"\]:lang\(ko\) \{\s*--font-sans: "Inter"/);
    const own = css.match(/@scope \(\[data-skin="precision"\], \[data-skin="snow-night"\], \[data-skin="precision-dimmed"\]\) to \(\[data-skin\]\) \{([\s\S]*?)\n\}/)![1];
    expect(own).toContain("max-width: min(54rem, 94%);");
    expect(own).toMatch(/\[data-orbit-message="bot"\] \[data-orbit-message-content\] \{\s*background: var\(--color-card\);/);
    expect(own).toMatch(/\[data-orbit-message="user"\] \[data-orbit-message-content\] \{\s*box-shadow: none;/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*@scope \(\[data-skin="precision"\], \[data-skin="snow-night"\], \[data-skin="precision-dimmed"\]\) to \(\[data-skin\]\) \{\s*\[data-orbit-message-body\] \{\s*max-width: 96%;/);
  });

  it("gives every non-Midnight skin its own focus and control tokens", () => {
    // Midnight inherits Grok-blue --color-focus from @theme. A light skin
    // that skips the token wears that blue on stone, paper, or porcelain.
    for (const id of SKIN_IDS) {
      if (id === "midnight") continue;
      expect([...tokensOf(id)]).toEqual(expect.arrayContaining(["--color-focus", "--color-control"]));
    }
  });

  it("declares every color token the stylesheet reads without a fallback", () => {
    // An undeclared var() voids its whole declaration at computed-value time.
    const declared = new Set([...css.matchAll(/(--color-[\w-]+)\s*:/g)].map(([, name]) => name));
    const read = new Set([...css.matchAll(/var\((--color-[\w-]+)\s*\)/g)].map(([, name]) => name));
    expect([...read].filter((t) => !declared.has(t))).toEqual([]);
  });

  it("describes each skin exactly once", () => {
    expect(SKINS.map((s) => s.id).sort()).toEqual([...SKIN_IDS].sort());
    for (const skin of SKINS) {
      expect(skin.name.length).toBeGreaterThan(0);
    }
  });

  it("keeps provider model dots at full color in every skin", () => {
    const dotRules = [...css.matchAll(/\[data-sidebar-model-dot\][^{]*\{([^}]*)\}/g)];
    for (const [, body] of dotRules) expect(body).not.toMatch(/filter|opacity/);
  });
});

const TERMINAL_SCOPE =
  '@scope (:is([data-skin="terminal"], [data-skin="terminal-dracula"], [data-skin="terminal-ice"], [data-skin="paper-tape"], [data-skin="logfile"], [data-skin="multiplexer"], [data-skin="modal"])) to ([data-skin]) {';

describe("Terminal composer", () => {
  const terminal = css.split(TERMINAL_SCOPE)[1]?.split("@keyframes term-blink")[0] ?? "";

  it("uses a transparent Stop control with the skin's hover colors", () => {
    const stop = terminal.match(/\[data-orbit-composer-stop\]\s*\{([^}]*)\}/)?.[1] ?? "";
    const hover = terminal.match(/\[data-orbit-composer-stop\]:hover\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(stop).toContain("background: transparent;");
    expect(stop).toContain("color: var(--color-ink-secondary);");
    expect(hover).toContain("background: var(--color-control);");
    expect(hover).toContain("color: var(--color-ink);");
    expect(hover).toContain("opacity: 1;");
    expect(css).toMatch(/:focus-visible\s*\{\s*outline: 2px solid var\(--color-focus\);/);
  });

  it("insets the prompt and reserves two characters before the text", () => {
    const frame = terminal.match(/\[data-orbit-composer-frame\]\s*\{([^}]*)\}/)?.[1] ?? "";
    const prompt = terminal.match(/\[data-orbit-composer-frame\]::after\s*\{([^}]*)\}/)?.[1] ?? "";
    const input = terminal.match(/\[data-orbit-composer\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(frame).toContain("padding-left: 0.75rem;");
    expect(prompt).toContain("left: 1rem;");
    expect(input).toContain("padding-left: calc(0.25rem + 2ch);");
    expect(prompt).toContain("pointer-events: none;");
  });

  it("aligns the prompt with the first textarea line", () => {
    const prompt = terminal.match(/\[data-orbit-composer-frame\]::after\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(prompt).toContain("top: 0.5rem;");
    expect(prompt).toContain("font-size: 15px;");
    expect(prompt).toContain("line-height: 1.5rem;");
  });
});

describe("Terminal tool rows", () => {
  const terminal = css.split(TERMINAL_SCOPE)[1]?.split("@keyframes term-blink")[0] ?? "";
  const rule = (selector: string) => terminal.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it("limits terminal tool rendering to the explicit terminal and TUI skins", () => {
    const tui = ["tui", "tui-black", "tui-amber", "tui-ice", "tui-slate", "tui-smoke"];
    for (const id of SKIN_IDS) expect(isTerminalToolSkin(id)).toBe(isTerminalSkin(id) || tui.includes(id));
    expect(isTerminalToolSkin("tuition-dark" as SkinId)).toBe(false);
  });

  it("hides both standard and WebKit disclosure markers", () => {
    const compact = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components/ActivityRun.css"), "utf8");
    expect(compact).toMatch(/\.term-step-head::marker,\s*\.term-step-head::-webkit-details-marker\s*\{\s*display: none;/);
  });

  it("wraps output rows inside the column instead of clipping them", () => {
    const out = rule(String.raw`\.term-step-out > div`);
    expect(out).toMatch(/white-space: pre-wrap;/);
    expect(out).toContain("overflow-wrap: anywhere;");
  });

  it("blinks on opacity so the tick stays off the main thread", () => {
    const blink = css.match(/@keyframes term-blink\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(blink).toContain("opacity: 0;");
    expect(blink).not.toContain("visibility");
  });

  it("wraps the header and clamps it at four lines", () => {
    const head = rule(String.raw`\.term-step-head`);
    expect(head).toContain("-webkit-line-clamp: 4;");
    expect(head).toContain("overflow-wrap: anywhere;");
  });
});

describe("Terminal palettes", () => {
  const PALETTES = { "terminal-dracula": "dracula", "terminal-ice": "tui-ice" } as const;

  it("follows Terminal in the list and shares its chrome", () => {
    const ids = SKINS.map((s) => s.id);
    const at = ids.indexOf("terminal");
    expect(ids.slice(at, at + 4)).toEqual(["terminal", "terminal-dracula", "terminal-ice", "paper-tape"]);
    for (const id of ["terminal", "terminal-dracula", "terminal-ice", "paper-tape"] as const) {
      expect(isTerminalSkin(id)).toBe(true);
      expect(TERMINAL_SCOPE).toContain(`[data-skin="${id}"]`);
    }
    expect(isTerminalSkin("tui-ice")).toBe(false);
  });

  it.each(Object.entries(PALETTES))("gives %s the %s colors", (id, source) => {
    const colors = (skin: string) =>
      [...(css.match(new RegExp(`\\[data-skin="${skin}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "").matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)]
        .map(([, name, value]) => `${name}:${value}`);
    expect(colors(id).length).toBeGreaterThan(15);
    expect(colors(id)).toEqual(colors(source));
  });

  it("makes Paper Tape a light terminal with a $ prompt and unbulleted replies", () => {
    expect(LIGHT_SKIN_IDS.has("paper-tape")).toBe(true);
    expect(luminance(cssToken("paper-tape", "--color-app")!)).toBeGreaterThan(0.75);
    expect(luminance(cssToken("paper-tape", "--color-ink")!)).toBeLessThan(0.02);
    const paper = css.split('@scope ([data-skin="paper-tape"]) to ([data-skin]) {')[1]?.split("@keyframes term-blink")[0] ?? "";
    expect(paper).toMatch(/\[data-orbit-message="bot"\] \[data-orbit-message-content\]::before\s*\{\s*content: none;/);
    expect(paper).toMatch(/\[data-orbit-composer-frame\]::after\s*\{\s*content: "\$";/);
  });
});

describe("Logfile, Multiplexer and Modal", () => {
  const toolCss = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../skins/tool-skins.css"), "utf8").replace(/\r\n/g, "\n");
  const scope = (id: string) => toolCss().split(`@scope ([data-skin="${id}"]) to ([data-skin]) {`)[1]?.split("\n}\n")[0] ?? "";
  const source = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../components", file), "utf8");

  it("follow Paper Tape in the list as dark skins on Terminal's chrome", () => {
    const ids = SKINS.map((s) => s.id);
    const at = ids.indexOf("paper-tape");
    expect(ids.slice(at + 1, at + 4)).toEqual(["logfile", "multiplexer", "modal"]);
    for (const id of ["logfile", "multiplexer", "modal"] as const) {
      expect(isTerminalSkin(id)).toBe(true);
      expect(TERMINAL_SCOPE).toContain(`[data-skin="${id}"]`);
      expect(LIGHT_SKIN_IDS.has(id)).toBe(false);
      expect(scope(id)).not.toBe("");
    }
  });

  it("stay out of the always-loaded stylesheet and use no :has()", () => {
    for (const id of ["logfile", "multiplexer", "modal"]) {
      expect(css).not.toContain(`@scope ([data-skin="${id}"])`);
      expect(scope(id)).not.toBe("");
    }
    expect(toolCss()).not.toContain(":has(");
  });

  it("prints Logfile's gutter from the rows' data-log attributes", () => {
    const log = scope("logfile");
    expect(log).toContain('content: "[" attr(data-log-time) "]";');
    expect(log).toMatch(/\[data-log-level="info"\]::after\s*\{\s*content: "INFO";/);
    expect(log).toMatch(/\[data-log-level="warn"\]::after\s*\{\s*content: "WARN";\s*color: var\(--color-warning\);/);
    for (const file of ["ChatView.tsx", "GroupView.tsx"]) {
      expect(source(file).match(/\{\.\.\.logLine\(skin === "logfile", /g)).toHaveLength(2);
    }
  });

  it("draws Multiplexer's pane box and status bar with the bot as the inverted window", () => {
    const mux = scope("multiplexer");
    expect(mux).toMatch(/\.term-status::before\s*\{\s*content: "0:" attr\(data-term-window\) "\*";/);
    expect(mux).toMatch(/main::after\s*\{[^}]*border: 1px solid var\(--color-accent\);[^}]*pointer-events: none;/);
    expect(source("TermStatusLine.tsx")).toContain("data-term-window={bot.name}");
  });

  it("switches Modal's mode on composer focus and numbers the transcript rows", () => {
    const vim = scope("modal");
    expect(vim).toMatch(/\[data-orbit-composer-frame\]::before\s*\{\s*content: "-- NORMAL --";/);
    expect(vim).toMatch(/\[data-orbit-composer-frame\]:focus-within::before\s*\{\s*content: "-- INSERT --";/);
    expect(vim).toContain("counter-increment: modal-line;");
    expect(vim).toMatch(/::after\s*\{\s*content: counter\(modal-line\) ",1\\00a0\\00a0\\00a0\\00a0 Bot";/);
  });
});

describe("Ledger", () => {
  it("is registered as a first-class skin", () => {
    expect(SKIN_IDS).toContain("ledger");
    expect(SKINS.some((s) => s.id === "ledger" && s.name === "Ledger")).toBe(true);
  });

  it("keeps the existing four skins and does not revive rejected ones", () => {
    for (const id of ["midnight", "atelier", "foundry", "lagoon"]) {
      expect(SKIN_IDS).toContain(id);
    }
    const ids: readonly string[] = SKIN_IDS;
    expect(ids).not.toContain("boreal");
    expect(css).not.toMatch(/\[data-skin="boreal"\]/);
  });

  it("is a neutral gray, distinct from Atelier's paper and Lagoon's porcelain", () => {
    const ledgerApp = cssToken("ledger", "--color-app");
    const atelierApp = cssToken("atelier", "--color-app");
    const lagoonApp = cssToken("lagoon", "--color-app");
    expect(ledgerApp).toBeTruthy();
    expect(ledgerApp).not.toBe(atelierApp);
    expect(ledgerApp).not.toBe(lagoonApp);
    expect(cssToken("ledger", "--color-accent")).not.toBe(cssToken("atelier", "--color-accent"));
    expect(cssToken("ledger", "--color-accent")).not.toBe(cssToken("lagoon", "--color-accent"));
    expect(cssToken("ledger", "--color-accent")).not.toBe("#a05f25");
    expect(cssToken("ledger", "--color-accent")).not.toBe("#11736d");
    // Channel spread is the tint: Atelier's cream and Lagoon's teal both
    // drift further from gray than Ledger's stone ground.
    expect(spread(ledgerApp!)).toBeLessThan(spread(atelierApp!));
    expect(spread(ledgerApp!)).toBeLessThan(spread(lagoonApp!));
  });

  it("keeps raised distinct from card so chips stay visible", () => {
    expect(cssToken("ledger", "--color-raised")).toBeTruthy();
    expect(cssToken("ledger", "--color-card")).toBeTruthy();
    expect(cssToken("ledger", "--color-raised")).not.toBe(cssToken("ledger", "--color-card"));
    expect(cssToken("ledger", "--color-control")).not.toBe(cssToken("ledger", "--color-card"));
    expect(cssToken("ledger", "--color-control")).not.toBe(cssToken("ledger", "--color-raised"));
  });

  it("ships the full light-skin token set, including focus", () => {
    const required = [
      "--color-app",
      "--color-panel",
      "--color-raised",
      "--color-raised-hover",
      "--color-card",
      "--color-inset",
      "--color-control",
      "--color-hairline",
      "--color-ink",
      "--color-ink-secondary",
      "--color-accent",
      "--color-accent-border",
      "--color-accent-text",
      "--color-accent-ink",
      "--color-focus",
      "--color-bubble-user",
      "--color-success",
      "--color-danger",
      "--color-danger-ink",
      "--color-warning",
      "--color-scrollbar",
      "--color-maus-line",
      "--font-sans",
      "--radius-lg",
      "--radius-xl",
    ];
    expect([...tokensOf("ledger")]).toEqual(expect.arrayContaining(required));
  });
});

describe("Community Light", () => {
  it("shares Community's open, wide replies on a light gray ground", () => {
    expect(css).toContain('@scope ([data-skin="community"], [data-skin="community-light"]) to ([data-skin])');
    expect(LIGHT_SKIN_IDS.has("community-light")).toBe(true);
    const app = cssToken("community-light", "--color-app")!;
    expect(luminance(app)).toBeGreaterThan(0.75);
    expect(spread(app)).toBeLessThanOrEqual(6);
  });
});

const EDITOR_DARK_SKINS = [
  {
    id: "vscode-dark",
    name: "VS Code Dark",
    tokens: {
      "--color-app": "#1e1e1e",
      "--color-panel": "#252526",
      "--color-inset": "#181818",
      "--color-ink": "#d4d4d4",
      "--color-accent": "#007acc",
      "--color-syntax-comment": "#6a9955",
      "--color-syntax-string": "#ce9178",
      "--color-syntax-constant": "#4fc1ff",
      "--color-syntax-tag": "#4ec9b0",
      "--color-syntax-function": "#dcdcaa",
    },
  },
  {
    id: "studio-gray",
    name: "Studio Gray",
    tokens: {
      "--color-app": "#242424",
      "--color-panel": "#303030",
      "--color-inset": "#1d1d1d",
      "--color-ink": "#e5e5e5",
      "--color-accent": "#7c9cff",
    },
  },
  {
    id: "steel-gray",
    name: "Steel Gray",
    tokens: {
      "--color-app": "#2b3038",
      "--color-panel": "#363c46",
      "--color-inset": "#22262d",
      "--color-ink": "#e2e8f0",
      "--color-accent": "#63d6be",
    },
  },
] as const;

describe("editor dark skins", () => {
  it("registers the optional palettes with their anchor tokens", () => {
    for (const skin of EDITOR_DARK_SKINS) {
      expect(SKIN_IDS).toContain(skin.id);
      expect(SKINS.some((s) => s.id === skin.id && s.name === skin.name)).toBe(true);
      for (const [token, value] of Object.entries(skin.tokens)) {
        expect(cssToken(skin.id, token)).toBe(value);
      }
    }
  });

  it("keeps VS Code Dark syntax accents readable on its editor inset", () => {
    const roles = [
      "--color-syntax-comment",
      "--color-syntax-string",
      "--color-syntax-constant",
      "--color-syntax-tag",
      "--color-syntax-function",
    ];
    const inset = cssToken("vscode-dark", "--color-inset")!;
    for (const role of roles) {
      expect(contrast(cssToken("vscode-dark", role)!, inset), role).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Claude skin", () => {
  it("uses a warm near-black palette and unboxed serif bot replies", () => {
    expect(SKIN_IDS).toContain("claude");
    expect(SKINS.some((skin) => skin.id === "claude" && skin.name === "Claude")).toBe(true);
    expect(cssToken("claude", "--color-app")).toBe("#171615");
    expect(cssToken("claude", "--color-accent")).toBe("#d97757");
    expect(css).toMatch(/\[data-skin="claude"\]\s*\[data-orbit-message="bot"\][\s\S]*?background:\s*transparent/);
    expect(css).toMatch(/\[data-skin="claude"\]\s*\[data-orbit-message="bot"\][\s\S]*?Anthropic Serif/);
    expect(css).toMatch(/\[data-skin="claude"\]\s*\[data-orbit-message="user"\][\s\S]*?border:\s*1px solid var\(--color-hairline\)/);
  });
});

const BLUEPRINT_DARK_SKINS = [
  {
    id: "blueprint-gray",
    name: "Blueprint Gray",
    tokens: {
      "--color-app": "#3a414a",
      "--color-panel": "#414952",
      "--color-raised": "#4d5661",
      "--color-inset": "#30373f",
      "--color-ink": "#f1f5f9",
      "--color-ink-secondary": "#d8e0e8",
      "--color-accent": "#8db9e8",
    },
  },
  {
    id: "blueprint-charcoal",
    name: "Blueprint Charcoal",
    tokens: {
      "--color-app": "#1f252c",
      "--color-panel": "#282f37",
      "--color-raised": "#343c46",
      "--color-inset": "#181e24",
      "--color-ink": "#eef3f8",
      "--color-ink-secondary": "#b7c4d0",
      "--color-accent": "#82b5e6",
    },
  },
] as const;

describe("dark Blueprint skins", () => {
  it("registers each with a distinct dark drafting palette", () => {
    for (const skin of BLUEPRINT_DARK_SKINS) {
      expect(SKIN_IDS).toContain(skin.id);
      expect(SKINS.some((entry) => entry.id === skin.id && entry.name === skin.name)).toBe(true);
      for (const [token, value] of Object.entries(skin.tokens)) {
        expect(cssToken(skin.id, token)).toBe(value);
      }
      const body = css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toMatch(/color-scheme:\s*dark/);
      expect(body).toContain('var(--font-geist) "Inter"');
    }
    expect(cssToken("blueprint-gray", "--color-app")).not.toBe(cssToken("blueprint-charcoal", "--color-app"));
  });

  it("keeps Blueprint message rules and monospace code treatment", () => {
    for (const id of ["blueprint-gray", "blueprint-charcoal"]) {
      expect(css).toMatch(new RegExp(`\\[data-skin="${id}"\\][\\s\\S]*?\\[data-orbit-message-content\\]`));
      expect(css).toContain(`[data-skin="${id}"]`);
    }
    expect(css).toContain("[data-orbit-message=\"bot\"] [data-orbit-message-content]");
    expect(css).toContain(".chat-md :is(code, pre)");
    expect(css).toContain('"Cascadia Mono", "Consolas", "Malgun Gothic", monospace');
  });
});

const FACE_SKINS = [
  { id: "instrument", name: "Instrument", face: "IBM Plex Sans", file: "IBMPlexSans-Variable.woff2", app: "#15181c" },
  { id: "matte", name: "Matte", face: "Nunito", file: "Nunito-Variable.woff2", app: "#1c1b19" },
  { id: "carbon", name: "Carbon", face: "JetBrains Mono", file: "JetBrainsMono-Variable.woff2", app: "#0b0c0d" },
  { id: "pewter", name: "Pewter", face: "Manrope", file: "Manrope-Variable.woff2", app: "#3a3d41" },
  { id: "coal", name: "Coal", face: "Space Grotesk", file: "SpaceGrotesk-Variable.woff2", app: "#121315" },
  { id: "folio", name: "Folio", face: "Literata", file: "Literata-Variable.woff2", app: "#232528" },
] as const;

describe("bundled-face skins", () => {
  const fonts = join(dirname(fileURLToPath(import.meta.url)), "../../public/fonts");

  it("registers each with its own bundled face first in the stack", () => {
    for (const skin of FACE_SKINS) {
      expect(SKINS.some((entry) => entry.id === skin.id && entry.name === skin.name)).toBe(true);
      expect(cssToken(skin.id, "--color-app")).toBe(skin.app);
      const body = css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body, skin.id).toMatch(new RegExp(`--font-sans:\\s*"${skin.face}"`));
      expect(css).toContain(`font-family: "${skin.face}";\n  src: url("/fonts/${skin.file}") format("woff2");`);
      expect(readdirSync(fonts)).toContain(skin.file);
    }
  });

  it("gives each a different card geometry", () => {
    const radii = FACE_SKINS.map((skin) => css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{[^}]*--radius-lg:\\s*([^;]+);`))?.[1]);
    expect(new Set(radii).size).toBe(FACE_SKINS.length);
    for (const skin of FACE_SKINS) {
      expect(css, skin.id).toMatch(new RegExp(`@scope \\([^)]*\\[data-skin="${skin.id}"\\][^)]*\\) to \\(\\[data-skin\\]\\)`));
    }
  });

  it("keeps chat ink at AA on every surface and accent fills readable", () => {
    for (const skin of FACE_SKINS) {
      const ink = cssToken(skin.id, "--color-ink")!;
      const secondary = cssToken(skin.id, "--color-ink-secondary")!;
      for (const surface of ["--color-app", "--color-card", "--color-bubble-user", "--color-inset", "--color-control"]) {
        expect(contrast(ink, cssToken(skin.id, surface)!), `${skin.id} ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(secondary, cssToken(skin.id, surface)!), `${skin.id} ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(cssToken(skin.id, "--color-accent-ink")!, cssToken(skin.id, "--color-accent")!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(cssToken(skin.id, "--color-danger-ink")!, cssToken(skin.id, "--color-danger")!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("steps Pewter Dusk and Pewter Night down from Pewter's palette only", () => {
    const pewter = SKIN_IDS.indexOf("pewter");
    expect(SKIN_IDS.slice(pewter, pewter + 3)).toEqual(["pewter", "pewter-dusk", "pewter-night"]);
    const shared = sharedBodies("pewter");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatch(/--font-sans:\s*"Manrope"/);
    expect(css).toContain('@scope ([data-skin="pewter"], [data-skin="pewter-dusk"], [data-skin="pewter-night"]) to ([data-skin])');
    let lighter = cssToken("pewter", "--color-app")!;
    for (const id of ["pewter-dusk", "pewter-night"]) {
      expect(sharedBodies(id), id).toEqual(shared);
      expect(DEFAULT_SKIN).not.toBe(id);
      const own = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))![1];
      expect([...own.matchAll(/(--[\w-]+)\s*:/g)].every(([, name]) => name.startsWith("--color-")), id).toBe(true);
      const app = cssToken(id, "--color-app")!;
      expect(app).not.toBe("#000000");
      expect(luminance(app)).toBeLessThan(luminance(lighter));
      expect(spread(app), id).toBeLessThanOrEqual(12);
      expect(spread(cssToken(id, "--color-accent")!), id).toBeLessThanOrEqual(64);
      for (const text of ["--color-ink", "--color-ink-secondary", "--color-accent-text"]) {
        for (const surface of ["--color-app", "--color-panel", "--color-card", "--color-bubble-user", "--color-inset", "--color-control", "--color-raised"]) {
          expect(contrast(cssToken(id, text)!, cssToken(id, surface)!), `${id} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(cssToken(id, "--color-accent-ink")!, cssToken(id, "--color-accent")!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(cssToken(id, "--color-danger-ink")!, cssToken(id, "--color-danger")!)).toBeGreaterThanOrEqual(4.5);
      lighter = app;
    }
  });

  it("keeps Coal a soft black under raised gray cards", () => {
    const app = cssToken("coal", "--color-app")!;
    expect(app).not.toBe("#000000");
    expect(luminance(app)).toBeGreaterThan(luminance("#0e0e0e"));
    expect(luminance(app)).toBeLessThan(luminance("#161616"));
    expect(contrast(cssToken("coal", "--color-card")!, app)).toBeGreaterThan(1.1);
  });

  it("keeps accents and grounds low-chroma", () => {
    for (const skin of FACE_SKINS) {
      expect(spread(cssToken(skin.id, "--color-accent")!), skin.id).toBeLessThanOrEqual(64);
      expect(spread(cssToken(skin.id, "--color-app")!), skin.id).toBeLessThanOrEqual(12);
    }
  });
});

const FRESH_SKINS = [
  { id: "inkwell", name: "Inkwell", face: "Atkinson Hyperlegible Next", file: "AtkinsonHyperlegibleNext-Variable.woff2", ratios: [12.4, 11.5, 1.12, 1.2] },
  { id: "graphite", name: "Graphite", face: "Lexend", file: "Lexend-Variable.woff2", ratios: [10.9, 9.8, 1.15, 1.28] },
  { id: "merlot", name: "Merlot", face: "Manrope", file: "Manrope-Variable.woff2", ratios: [14.1, 11.6, 1.12, 1.36] },
] as const;

describe("Inkwell, Graphite and Merlot", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

  it("registers the three dark skins and keeps Wink Violet, Wink Black, Pewter and the default", () => {
    for (const skin of FRESH_SKINS) {
      expect(SKINS.some((entry) => entry.id === skin.id && entry.name === skin.name)).toBe(true);
      expect(LIGHT_SKIN_IDS.has(skin.id)).toBe(false);
    }
    for (const id of ["wink-violet", "wink-black", "pewter"]) expect(SKIN_IDS).toContain(id);
    expect(DEFAULT_SKIN).toBe("precision");
  });

  it("keeps the picked bot text, user text and bubble contrast", () => {
    for (const { id, ratios } of FRESH_SKINS) {
      const [ink, app, card, user] = ["--color-ink", "--color-app", "--color-card", "--color-bubble-user"].map((name) => cssToken(id, name)!);
      [contrast(ink, card), contrast(ink, user), contrast(card, app), contrast(user, app)].forEach((ratio, i) => {
        expect(Math.abs(ratio - ratios[i]), `${id} ${i}`).toBeLessThan(0.06);
      });
    }
  });

  it.each(FRESH_SKINS)("lets $id's root-level tokens outrank the :root defaults", ({ id }) => {
    const rule = css.match(new RegExp(`:root\\[data-skin="${id}"\\],\\s*\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`));
    expect(rule?.[1]).toContain("--color-accent-ink");
  });

  it("puts both sides in wide bubbles", () => {
    const scope = '@scope (:is([data-skin="inkwell"], [data-skin="graphite"], [data-skin="merlot"], [data-skin="bronze"], [data-skin="dim-sand"])) to ([data-skin]) {';
    const body = css.slice(css.indexOf(scope), css.indexOf("\n}\n", css.indexOf(scope)));
    expect(body).toContain("max-width: min(54rem, 94%);");
    expect(body).toMatch(/\[data-orbit-message="bot"\] \[data-orbit-message-content\] \{\s*background: var\(--color-card\);/);
    expect(body).toMatch(/\[data-orbit-message="user"\] \[data-orbit-message-content\] \{\s*background: var\(--color-bubble-user\);/);
  });

  it("names each face only in its own skin and preloads it only for that skin", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    const map = html.match(/var font = \{([^}]*)\}/)![1];
    const preload = [...map.matchAll(/"?([a-z-]+)"?: "(\w+)"/g)].map(([, id, font]) => [id, `${font}-Variable.woff2`]);
    for (const { id, face, file } of FRESH_SKINS) {
      expect(readdirSync(join(root, "public/fonts"))).toContain(file);
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body, id).toMatch(new RegExp(`--font-sans:\\s*"${face}"`));
      expect(preload.find(([skin]) => skin === id)?.[1]).toBe(file);
    }
    for (const { id, face, file } of FRESH_SKINS.slice(0, 2)) {
      expect(css).toContain(`font-family: "${face}";\n  src: url("/fonts/${file}") format("woff2");`);
      expect(css.split(`"${face}"`).length - 1, face).toBe(2);
      expect(preload.filter(([, font]) => font === file).map(([skin]) => skin)).toEqual([id]);
    }
  });
});

const EDGE_SKINS = ["precision-dimmed", "bronze", "dim-sand", "wink-day", "atelier"] as const;

describe("Precision Dimmed, Bronze, Dim Sand and the Light and Atelier fixes", () => {
  it("registers the three skins, with Dim Sand as the light one", () => {
    expect(SKINS.filter((skin) => ["precision-dimmed", "bronze", "dim-sand"].includes(skin.id))).toEqual([
      { id: "precision-dimmed", name: "Precision Dimmed" },
      { id: "bronze", name: "Bronze" },
      { id: "dim-sand", name: "Dim Sand" },
    ]);
    expect(SKINS.find((skin) => skin.id === "merlot")?.name).toBe("Merlot");
    expect([...LIGHT_SKIN_IDS].filter((id) => ["precision-dimmed", "bronze", "dim-sand"].includes(id))).toEqual(["dim-sand"]);
  });

  it("ships the fixed Light and Atelier tokens", () => {
    const fixed = {
      "wink-day": { app: "#eeebf7", panel: "#e3dff0", inset: "#e9e5f3", control: "#d9d4e9", "raised-hover": "#f3f0fa", hairline: "#aaa4c6", "bubble-user": "#fad6e6", scrollbar: "#9f99bd", edge: "#7f79a3", accent: "#b91a61", "accent-border": "#dc4188", success: "#17633e", danger: "#a5211a", warning: "#7b4e00" },
      atelier: { app: "#f0e9de", panel: "#f8f3ea", inset: "#efe8dc", control: "#e4d9c6", "raised-hover": "#eadfcd", hairline: "#b3a78e", "bubble-user": "#ead9c0", scrollbar: "#ab9f87", edge: "#8b8069", "ink-secondary": "#615b50", "accent-text": "#8c4e1b", success: "#3a6442", warning: "#70572c" },
    };
    expect(Object.values(fixed).flatMap(Object.keys)).toHaveLength(27);
    for (const [id, tokens] of Object.entries(fixed)) {
      for (const [name, value] of Object.entries(tokens)) expect(cssToken(id, `--color-${name}`), `${id} ${name}`).toBe(value);
    }
  });

  it("ships Bronze on the design tokens", () => {
    const bronze = { app: "#181512", panel: "#120f0c", ink: "#ebe7e1", "ink-secondary": "#b4ada3", accent: "#cca779", "bubble-user": "#413321", hairline: "#47433f", edge: "#78746e" };
    for (const [name, value] of Object.entries(bronze)) expect(cssToken("bronze", `--color-${name}`), name).toBe(value);
  });

  it.each(EDGE_SKINS)("keeps %s's text, muted text and accent text at AA on every surface", (id) => {
    for (const text of ["--color-ink", "--color-ink-secondary", "--color-accent-text"]) {
      for (const surface of ["--color-app", "--color-panel", "--color-raised", "--color-raised-hover", "--color-card", "--color-inset", "--color-control", "--color-bubble-user"]) {
        expect(contrast(skinToken(id, text), skinToken(id, surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(skinToken(id, "--color-accent-ink"), skinToken(id, "--color-accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(EDGE_SKINS)("edges %s's chat box and search field at 3:1", (id) => {
    for (const surface of ["--color-app", "--color-panel", "--color-raised", "--color-card"]) {
      expect(contrast(skinToken(id, "--color-edge"), skinToken(id, surface)), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps Dim Sand's ground well under Wink Day's and every new color off green", () => {
    expect(luminance(skinToken("dim-sand", "--color-app"))).toBeLessThan(luminance(skinToken("wink-day", "--color-app")) * 0.6);
    for (const id of ["precision-dimmed", "bronze", "dim-sand"]) {
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))![1];
      for (const [, hex] of body.matchAll(/--color-[\w-]+:\s*(#[0-9a-f]{6})/g)) {
        const { r, g, b } = channels(hex);
        expect(g > r + 12 && g > b + 12, `${id} ${hex}`).toBe(false);
      }
    }
  });
});

describe("Bot name on wide bubbles", () => {
  const WIDE = ["precision", "inkwell", "graphite", "merlot", "precision-dimmed", "bronze", "dim-sand", "snow-night"];
  const NAMED_ALREADY = [
    "wink", "wink-cyber", "wink-violet", "wink-black", "wink-day", "community", "community-light", "code-review",
    "instrument", "carbon", "pewter", "pewter-dusk", "pewter-night", "coal", "folio", "snow",
  ];

  function scopeBodies(id: string): string {
    const bodies: string[] = [];
    for (const match of css.matchAll(/@scope \(([^{]*)\) to \(\[data-skin\]\) \{/g)) {
      if (!match[1].includes(`[data-skin="${id}"]`)) continue;
      let depth = 0;
      for (let i = match.index! + match[0].length - 1; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) {
          bodies.push(css.slice(match.index!, i));
          break;
        }
      }
    }
    return bodies.join("\n");
  }

  const showsBotName = (id: string) =>
    /(?:\[data-orbit-message="bot"\] )?\.orbit-message-speaker \{[^}]*display: block/.test(scopeBodies(id)) ||
    new RegExp(String.raw`\[data-skin="${id}"\] \.orbit-message-speaker \{[^}]*display: block`).test(css);

  it("shows the name on bot replies in each wide skin and no other skin gains it", () => {
    for (const id of WIDE) {
      expect(scopeBodies(id), id).toMatch(/\[data-orbit-message="bot"\] \.orbit-message-speaker \{[^}]*display: block/);
      expect(scopeBodies(id), id).toMatch(/max-width: (?:min\(54rem, )?9[46]%/);
    }
    expect(SKIN_IDS.filter(showsBotName).sort()).toEqual([...NAMED_ALREADY, ...WIDE].sort());
  });

  it("hides the narrow skins' name and never names the user side", () => {
    for (const id of SKIN_IDS.filter((skin) => !WIDE.includes(skin) && !NAMED_ALREADY.includes(skin))) expect(showsBotName(id), id).toBe(false);
    for (const id of WIDE) expect(scopeBodies(id), id).not.toMatch(/\[data-orbit-message="user"\] \.orbit-message-speaker/);
  });

  it("leaves the name to the room's cluster label", () => {
    for (const id of WIDE) expect(scopeBodies(id), id).toMatch(/\[data-room-transcript\] \.orbit-message-speaker \{\s*display: none;/);
  });
});

const WINK_SKINS = [
  { id: "wink", name: "Wink", face: "Space Grotesk", file: "SpaceGrotesk-Variable.woff2", lead: "#ff4d9d", caret: "#ffd447" },
  { id: "wink-cyber", name: "Wink Cyber", face: "IBM Plex Sans", file: "IBMPlexSans-Variable.woff2", lead: "#38d8ff", caret: "#aaff5a" },
  { id: "wink-violet", name: "Wink Violet", face: "Nunito", file: "Nunito-Variable.woff2", lead: "#a770ff", caret: "#6ef0be" },
  { id: "wink-black", name: "Wink Black", face: "JetBrains Mono", file: "JetBrainsMono-Variable.woff2", lead: "#ffd447", caret: "#ff4d9d" },
  { id: "wink-day", name: "Wink Day", face: "Manrope", file: "Manrope-Variable.woff2", lead: "#b91a61", caret: "var(--color-accent)" },
] as const;

const WINK_NAVY = ["wink", "wink-cyber", "wink-violet"];

describe("Wink family", () => {
  const fonts = join(dirname(fileURLToPath(import.meta.url)), "../../public/fonts");

  it("leads the picker without changing the default", () => {
    expect(SKIN_IDS.slice(0, 5)).toEqual(WINK_SKINS.map((s) => s.id));
    expect(SKINS.slice(0, 5).map((s) => s.name)).toEqual(WINK_SKINS.map((s) => s.name));
    expect(DEFAULT_SKIN).toBe("precision");
  });

  it("sets each in its own bundled face with its lead and caret", () => {
    for (const skin of WINK_SKINS) {
      const body = css.match(new RegExp(`\\[data-skin="${skin.id}"\\]\\s*\\{([^}]*)\\}`))![1];
      expect(body, skin.id).toMatch(new RegExp(`--font-sans:\\s*"${skin.face}"`));
      expect(readdirSync(fonts)).toContain(skin.file);
      expect(cssToken(skin.id, "--color-accent")).toBe(skin.lead);
      expect(css, skin.id).toContain(`[data-skin="${skin.id}"] :is(input, textarea) { caret-color: ${skin.caret}; }`);
    }
    expect(cssToken("wink", "--color-focus")).toBe("#ffd447");
    expect(cssToken("wink-cyber", "--color-focus")).toBe("#aaff5a");
    expect(cssToken("wink-violet", "--color-focus")).toBe("#6ef0be");
    expect(cssToken("wink-black", "--color-focus")).toBe("#ff4d9d");
    expect(css).toMatch(/\[data-skin="wink-day"\] ::selection \{\s*background: #ffe27a;/);
  });

  it("keeps Wink, Cyber, and Violet on the icon navy, Wink Black true black, Wink Day light", () => {
    expect(css).toContain('@scope ([data-skin="wink"], [data-skin="wink-cyber"], [data-skin="wink-violet"]) to ([data-skin])');
    for (const id of WINK_NAVY) {
      const { r, g, b } = channels(cssToken(id, "--color-app")!);
      expect(b - r, id).toBeGreaterThanOrEqual(12);
      expect(b - g, id).toBeGreaterThanOrEqual(10);
      for (const token of ["--color-app", "--color-card", "--color-raised", "--color-hairline", "--color-bubble-user"]) {
        expect(cssToken(id, token), `${id} ${token}`).toBe(cssToken("wink", token));
      }
      expect(spread(cssToken(id, "--color-accent")!), id).toBeGreaterThan(140);
    }
    expect(cssToken("wink-black", "--color-app")).toBe("#000000");
    expect(luminance(cssToken("wink-day", "--color-app")!)).toBeGreaterThan(0.8);
    for (const other of ["hurtado", "tui-amber", "midnight", "tokyo-night"]) {
      for (const skin of WINK_SKINS) {
        expect(cssToken(skin.id, "--color-accent"), `${skin.id} vs ${other}`).not.toBe(cssToken(other, "--color-accent"));
      }
    }
    expect(css).toMatch(/\[data-skin="wink-black"\] \{[^}]*--radius-lg: 10px;/);
  });

  it("keeps chat text at AA and fills readable at rest and on hover", () => {
    for (const { id } of WINK_SKINS) {
      for (const text of ["--color-ink", "--color-ink-secondary", "--color-accent-text"]) {
        for (const surface of ["--color-app", "--color-panel", "--color-card", "--color-bubble-user", "--color-inset", "--color-control", "--color-raised", "--color-raised-hover"]) {
          expect(contrast(cssToken(id, text)!, cssToken(id, surface)!), `${id} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const [ink, fill] of [["--color-accent-ink", "--color-accent"], ["--color-danger-ink", "--color-danger"]]) {
        const [i, f] = [cssToken(id, ink)!, cssToken(id, fill)!];
        expect(contrast(i, f), `${id} ${fill}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(brightness110(i), brightness110(f)), `${id} ${fill} hover`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(cssToken(id, "--color-focus")!, cssToken(id, "--color-app")!), id).toBeGreaterThanOrEqual(3);
    }
  });

  it("derives terminal colors from each palette", () => {
    for (const { id } of WINK_SKINS) {
      const theme = terminalTheme((name) => skinToken(id, `--color-${name}`));
      expect(theme.background).toBe(cssToken(id, "--color-inset"));
      expect(theme.foreground).toBe(cssToken(id, "--color-ink"));
      expect(theme.cursor).toBe(cssToken(id, "--color-accent-text"));
    }
    const day = terminalTheme((name) => skinToken("wink-day", `--color-${name}`));
    expect(day.red).toBe(cssToken("wink-day", "--color-syntax-keyword"));
  });
});

const DARK_INK_SKINS = [
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappe",
    tokens: {
      "--color-app": "#303446",
      "--color-raised": "#363a4f",
      "--color-ink": "#c6d0f5",
      "--color-ink-secondary": "#b5bfe2",
      "--color-accent": "#a6d189",
      "--color-hairline": "#626880",
      "--color-danger": "#e78284",
      "--color-success": "#a6d189",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    tokens: {
      "--color-app": "#1a1b26",
      "--color-raised": "#24283b",
      "--color-ink": "#c0caf5",
      "--color-ink-secondary": "#a9b1d6",
      "--color-accent": "#7aa2f7",
      "--color-hairline": "#3b4261",
      "--color-danger": "#f7768e",
      "--color-success": "#9ece6a",
    },
  },
  {
    id: "vesper",
    name: "Vesper",
    tokens: {
      "--color-app": "#101010",
      "--color-raised": "#1c1c1c",
      "--color-ink": "#ffffff",
      "--color-ink-secondary": "#a0a0a0",
      "--color-accent": "#ffc799",
      "--color-hairline": "#363636",
      "--color-danger": "#ff8080",
      "--color-success": "#99ffe4",
    },
  },
  {
    id: "onyx",
    name: "Onyx",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#141414",
      "--color-ink": "#e8e6e3",
      "--color-ink-secondary": "#a8a6a3",
      "--color-accent": "#bb9af7",
      "--color-hairline": "#2d2d2d",
      "--color-danger": "#f2655f",
      "--color-success": "#73daca",
    },
  },
  {
    id: "peach",
    name: "Peach",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#13151a",
      "--color-ink": "#eceef2",
      "--color-ink-secondary": "#a6abb5",
      "--color-accent": "#ffd3b6",
      "--color-hairline": "#2a2d35",
      "--color-danger": "#ff7d7d",
      "--color-success": "#7fe0c9",
    },
  },
  {
    id: "coral",
    name: "Coral",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#141414",
      "--color-ink": "#ebe8e7",
      "--color-ink-secondary": "#aaa6a5",
      "--color-accent": "#ff8b85",
      "--color-hairline": "#2d2d2d",
      "--color-danger": "#f04a4a",
      "--color-success": "#7bdcb5",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    tokens: {
      "--color-app": "#282a36",
      "--color-raised": "#343746",
      "--color-ink": "#f8f8f2",
      "--color-ink-secondary": "#a4abcc",
      "--color-accent": "#bd93f9",
      "--color-hairline": "#44475a",
      "--color-danger": "#ff6b6b",
      "--color-success": "#50fa7b",
    },
  },
  {
    id: "cobalt",
    name: "Panda Syntax",
    tokens: {
      "--color-app": "#292a2b",
      "--color-raised": "#373b41",
      "--color-ink": "#e6e6e6",
      "--color-ink-secondary": "#bcaafe",
      "--color-accent": "#19f9d8",
      "--color-hairline": "#4a4e5c",
      "--color-danger": "#ff75b5",
      "--color-success": "#6fe7d2",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    tokens: {
      "--color-app": "#282828",
      "--color-raised": "#46413e",
      "--color-ink": "#ebdbb2",
      "--color-ink-secondary": "#d5c4a1",
      "--color-accent": "#fe8019",
      "--color-hairline": "#7c6f64",
      "--color-danger": "#ff8f85",
      "--color-success": "#b8bb26",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    tokens: {
      "--color-app": "#191724",
      "--color-raised": "#26233a",
      "--color-ink": "#e0def4",
      "--color-ink-secondary": "#918daa",
      "--color-accent": "#c4a7e7",
      "--color-hairline": "#403d52",
      "--color-danger": "#eb6f92",
      "--color-success": "#9ccfd8",
    },
  },
  {
    id: "nord",
    name: "Nord",
    tokens: {
      "--color-app": "#2e3440",
      "--color-raised": "#434c5e",
      "--color-ink": "#eceff4",
      "--color-ink-secondary": "#d8dee9",
      "--color-accent": "#88c0d0",
      "--color-hairline": "#4c566a",
      "--color-danger": "#ff9aa3",
      "--color-success": "#a3be8c",
    },
  },
  {
    id: "github-dimmed",
    name: "GitHub Dimmed",
    tokens: {
      "--color-app": "#22272e",
      "--color-raised": "#373e47",
      "--color-ink": "#cdd9e5",
      "--color-ink-secondary": "#b0bdca",
      "--color-accent": "#539bf5",
      "--color-hairline": "#444c56",
      "--color-danger": "#ff7b72",
      "--color-success": "#58ad5b",
    },
  },
  {
    id: "tui",
    name: "TUI",
    tokens: {
      "--color-app": "#0c0c0c",
      "--color-raised": "#1a1a1a",
      "--color-ink": "#cccccc",
      "--color-ink-secondary": "#a0a0a0",
      "--color-accent": "#13a8a8",
      "--color-hairline": "#3a3a3a",
      "--color-danger": "#ff6b6b",
      "--color-success": "#3dd6d6",
    },
  },
  {
    id: "tui-black",
    name: "TUI Black",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#141414",
      "--color-ink": "#c8c8c8",
      "--color-ink-secondary": "#9a9a9a",
      "--color-accent": "#13a8a8",
      "--color-hairline": "#2d2d2d",
      "--color-danger": "#ff6b6b",
      "--color-success": "#3dd6d6",
    },
  },
  {
    id: "tui-amber",
    name: "TUI Amber",
    tokens: {
      "--color-app": "#1a1a1a",
      "--color-raised": "#2c2c2c",
      "--color-ink": "#dedcd7",
      "--color-ink-secondary": "#aaa7a0",
      "--color-accent": "#d6b779",
      "--color-hairline": "#3d3d3d",
      "--color-danger": "#ff6b6b",
      "--color-success": "#dedcd7",
    },
  },
  {
    id: "tui-ice",
    name: "TUI Ice",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#101418",
      "--color-ink": "#c8dce8",
      "--color-ink-secondary": "#8aa8b8",
      "--color-accent": "#7dcfff",
      "--color-hairline": "#243038",
      "--color-danger": "#ff6b6b",
      "--color-success": "#73daca",
    },
  },
  {
    id: "tui-slate",
    name: "TUI Slate",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#16161a",
      "--color-ink": "#c4c4cc",
      "--color-ink-secondary": "#8a8a94",
      "--color-accent": "#c8c8d0",
      "--color-hairline": "#2e2e36",
      "--color-danger": "#ff6b6b",
      "--color-success": "#c4c4cc",
    },
  },
  {
    id: "tui-smoke",
    name: "TUI Smoke",
    tokens: {
      "--color-app": "#000000",
      "--color-raised": "#181614",
      "--color-ink": "#c8c4bc",
      "--color-ink-secondary": "#8a8680",
      "--color-accent": "#a39e96",
      "--color-hairline": "#322e28",
      "--color-danger": "#ff6b6b",
      "--color-success": "#c8c4bc",
    },
  },
] as const;

describe("dark ink skins", () => {
  it("registers each as a first-class dark skin", () => {
    for (const skin of DARK_INK_SKINS) {
      expect(SKIN_IDS).toContain(skin.id);
      expect(SKINS.some((s) => s.id === skin.id && s.name === skin.name)).toBe(true);
    }
  });

  it("keeps the existing light skins", () => {
    for (const id of ["atelier", "lagoon", "ledger"]) {
      expect(SKIN_IDS).toContain(id);
    }
  });

  it("ships the given palette tokens exactly", () => {
    for (const skin of DARK_INK_SKINS) {
      for (const [token, value] of Object.entries(skin.tokens)) {
        expect(cssToken(skin.id, token)).toBe(value);
      }
    }
  });

  it("gives each dark skin a raised surface distinct from its panel background", () => {
    for (const skin of DARK_INK_SKINS) {
      const panel = cssToken(skin.id, "--color-panel");
      const raised = cssToken(skin.id, "--color-raised");
      expect(raised).not.toBe(panel);
    }
  });

  it("puts each skin's ground on accent and danger fills, not Midnight white", () => {
    for (const skin of DARK_INK_SKINS) {
      const bg = skin.tokens["--color-app"];
      expect(cssToken(skin.id, "--color-accent-ink")).toBe(bg);
      expect(cssToken(skin.id, "--color-danger-ink")).toBe(bg);
      expect(cssToken(skin.id, "--color-accent-ink")).not.toBe("#ffffff");
      expect(cssToken(skin.id, "--color-danger-ink")).not.toBe("#ffffff");
    }
  });

  it("gives every TUI skin zero radius and a monospace stack", () => {
    for (const id of ["tui", "tui-black", "tui-amber", "tui-ice", "tui-slate", "tui-smoke"]) {
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body, id).toMatch(/--radius-lg:\s*0px/);
      expect(body, id).toMatch(/--radius-xl:\s*0px/);
      expect(body, id).toMatch(/ui-monospace/);
      expect(body, id).not.toMatch(/"Inter"/);
    }
  });

  it("gives Onyx ice links and peach warning, not silver chrome", () => {
    expect(cssToken("onyx", "--color-accent-text")).toBe("#7dcfff");
    expect(cssToken("onyx", "--color-warning")).toBe("#ff9e64");
    expect(cssToken("onyx", "--color-accent")).toBe("#bb9af7");
    expect(cssToken("onyx", "--color-accent")).not.toBe("#e4e4e7");
  });

  it("keeps Onyx ground true-black and ink off-white", () => {
    expect(cssToken("onyx", "--color-app")).toBe("#000000");
    expect(cssToken("onyx", "--color-ink")).toBe("#e8e6e3");
    expect(cssToken("onyx", "--color-ink")).not.toBe("#ffffff");
    expect(cssToken("onyx", "--color-ink")).not.toBe("#ededf0");
  });

  it("keeps Peach lighter and colder than Vesper, and Coral distinct from its danger", () => {
    expect(luminance(cssToken("peach", "--color-accent")!)).toBeGreaterThan(luminance(cssToken("vesper", "--color-accent")!));
    expect(cssToken("peach", "--color-app")).toBe("#000000");
    expect(cssToken("coral", "--color-app")).toBe("#000000");
    expect(cssToken("coral", "--color-danger")).not.toBe(cssToken("coral", "--color-accent"));
  });

  it("derives Peach and Coral terminal colors from the shipped palette", () => {
    for (const id of ["peach", "coral"]) {
      const theme = terminalTheme((name) => cssToken(id, `--color-${name}`) ?? "");
      expect(theme.background).toBe("#000000");
      expect(theme.cursor).toBe(cssToken(id, "--color-accent-text"));
      expect(theme.foreground).toBe(cssToken(id, "--color-ink"));
    }
  });

  it("keeps chat ink and accent text at AA on every Peach and Coral surface", () => {
    for (const id of ["peach", "coral"]) {
      for (const text of ["--color-ink", "--color-ink-secondary", "--color-accent-text", "--color-danger", "--color-success", "--color-warning"]) {
        for (const surface of ["--color-app", "--color-panel", "--color-card", "--color-bubble-user", "--color-inset", "--color-control", "--color-raised"]) {
          expect(contrast(cssToken(id, text)!, cssToken(id, surface)!), `${id} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(cssToken(id, "--color-accent-ink")!, cssToken(id, "--color-accent")!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives Panda a warning apricot distinct from the mint accent", () => {
    const warning = cssToken("cobalt", "--color-warning");
    const accent = cssToken("cobalt", "--color-accent");
    expect(warning).toBe("#ffb86c");
    expect(accent).toBe("#19f9d8");
    expect(warning).not.toBe(accent);
  });

  it("gives Panda a light-green success distinct from the mint accent", () => {
    const success = cssToken("cobalt", "--color-success");
    const accent = cssToken("cobalt", "--color-accent");
    expect(success).toBe("#6fe7d2");
    expect(accent).toBe("#19f9d8");
    expect(success).not.toBe(accent);
  });

  it("maintains WCAG AA contrast on danger fills in all dark skins", () => {
    for (const skin of DARK_INK_SKINS) {
      const danger = cssToken(skin.id, "--color-danger")!;
      const ink = cssToken(skin.id, "--color-danger-ink")!;
      expect(contrast(ink, danger)).toBeGreaterThanOrEqual(4.5);
    }
  });

  const DANGER_PAIRINGS = [
    {
      file: "src/components/GroupView.tsx",
      snippet: "border border-transparent px-3 py-1.5 text-[13px]",
      textToken: "--color-danger",
      surfaceToken: "--color-app",
    },
    {
      file: "src/components/Sidebar.tsx",
      snippet: "text-danger hover:bg-raised/40",
      textToken: "--color-danger",
      surfaceToken: "--color-card",
    },

  ] as const;

  it("gives danger pairings WCAG AA contrast", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    for (const row of DANGER_PAIRINGS) {
      const source = readFileSync(join(repoRoot, row.file), "utf8");
      expect.soft(source).toContain(row.snippet);
    }

    const chip = DANGER_PAIRINGS.find((p) => p.file.endsWith("GroupView.tsx"))!;

    // Rest surface in gruvbox: RoomToolChip on app
    expect.soft(contrast(cssToken("gruvbox", chip.textToken)!, cssToken("gruvbox", chip.surfaceToken)!)).toBeGreaterThanOrEqual(4.5);

  });

  it("keeps red danger text readable at rest and on hover across all skins", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const allSkins = ["default", ...SKIN_IDS];

    const sidebarSrc = readFileSync(join(repoRoot, "src/components/Sidebar.tsx"), "utf8");
    const avatarSrc = readFileSync(join(repoRoot, "src/components/BotProfileAvatarCard.tsx"), "utf8");

    const deleteChannelIdx = sidebarSrc.indexOf("chrome.deleteChannel");
    expect(deleteChannelIdx, "chrome.deleteChannel found in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const deleteChannelSlice = sidebarSrc.slice(sidebarSrc.lastIndexOf("<button", deleteChannelIdx), deleteChannelIdx);

    const removeFromContextIdx = sidebarSrc.indexOf("chrome.removeFromContext");
    expect(removeFromContextIdx, "chrome.removeFromContext found in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const removeFromContextSlice = sidebarSrc.slice(sidebarSrc.lastIndexOf("<button", removeFromContextIdx), removeFromContextIdx);

    const deleteIdx = sidebarSrc.indexOf('"chrome.delete"');
    expect(deleteIdx, "chrome.delete found in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const itemIdx = sidebarSrc.lastIndexOf("const item", deleteIdx);
    expect(itemIdx, "item() definition found before chrome.delete in Sidebar.tsx").toBeGreaterThanOrEqual(0);
    const buttonEnd = sidebarSrc.indexOf("</button>", itemIdx);
    const itemEnd = sidebarSrc.indexOf(");", buttonEnd);
    const itemSlice = sidebarSrc.slice(itemIdx, itemEnd + 2);

    function textHoverSurface(slice: string, danger: string, card: string, raised: string, raisedHover: string): string {
      if (slice.includes("hover:bg-raised/40")) return blend(raised, card, 0.4);
      if (slice.includes("hover:bg-danger/10")) return blend(danger, card, 0.1);
      if (slice.includes("hover:bg-raised/70")) return blend(raised, card, 0.7);
      if (slice.includes("hover:bg-raised-hover")) return raisedHover;
      throw new Error(`Unknown hover class in slice: ${slice}`);
    }

    for (const skin of allSkins) {
      const danger = skinToken(skin, "--color-danger");
      const card = skinToken(skin, "--color-card");
      const raised = skinToken(skin, "--color-raised");
      const raisedHover = skinToken(skin, "--color-raised-hover");
      const control = skinToken(skin, "--color-control");

      // 1. Sidebar "chrome.deleteChannel"
      const deleteChannelRest = /(?<!hover:)bg-raised\b/.test(deleteChannelSlice) ? raised : card;
      const deleteChannelHover = textHoverSurface(deleteChannelSlice, danger, card, raised, raisedHover);
      expect.soft(contrast(danger, deleteChannelRest), `${skin} Sidebar deleteChannel rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast(danger, deleteChannelHover), `${skin} Sidebar deleteChannel hover`).toBeGreaterThanOrEqual(4.5);

      // 2. Sidebar "chrome.removeFromContext"
      const removeContextRest = /(?<!hover:)bg-raised\b/.test(removeFromContextSlice) ? raised : card;
      const removeContextHover = textHoverSurface(removeFromContextSlice, danger, card, raised, raisedHover);
      expect.soft(contrast(danger, removeContextRest), `${skin} Sidebar removeFromContext rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast(danger, removeContextHover), `${skin} Sidebar removeFromContext hover`).toBeGreaterThanOrEqual(4.5);

      // 3. Sidebar "chrome.delete" (the item() row)
      const deleteRest = card;
      const deleteHover = itemSlice.includes("opts?.danger") && itemSlice.includes("hover:bg-raised/40")
        ? blend(raised, card, 0.4)
        : textHoverSurface(itemSlice, danger, card, raised, raisedHover);
      expect.soft(contrast(danger, deleteRest), `${skin} Sidebar chrome.delete rest`).toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast(danger, deleteHover), `${skin} Sidebar chrome.delete hover`).toBeGreaterThanOrEqual(4.5);

      // Icon-only control 2: BotProfileAvatarCard remove button
      const avatarHover = avatarSrc.includes("hover:bg-danger/10") ? blend(danger, card, 0.1) : control;
      expect.soft(contrast(danger, avatarHover), `${skin} BotProfileAvatarCard hover`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("maintains WCAG AA contrast between secondary ink and controls in dark skins", () => {
    for (const skin of DARK_INK_SKINS) {
      const secondary = cssToken(skin.id, "--color-ink-secondary")!;
      const control = cssToken(skin.id, "--color-control")!;
      expect(contrast(secondary, control)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Boxy shape", () => {
  // Extracts one rule's { declarations } at a time, tracking brace depth so it
  // also works inside @scope/@media wrappers without matching their own braces.
  function balancedBody(source: string, openBraceIdx: number): string {
    let depth = 0;
    for (let i = openBraceIdx; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(openBraceIdx + 1, i);
      }
    }
    throw new Error("unbalanced braces in styles.css");
  }

  function flatRules(body: string): { selector: string; declarations: string }[] {
    return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, declarations]) => ({
      selector: selector.trim(),
      declarations,
    }));
  }

  it("leaves no theme-scoped radius rule able to escape Boxy", () => {
    // Comments (which may contain commas) would otherwise bleed into the
    // selector text a regex captures right after them.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

    // The only radius Boxy is allowed to leave alone: a decoration that was
    // never a corner in the first place (the choice-signal selection dot).
    const exempt = ["[data-choice-signal]"];

    const boxyScopeStart = stripped.indexOf('@scope (:root[data-shape="boxy"]) to ([data-skin])');
    expect(boxyScopeStart).toBeGreaterThan(-1);
    const boxyBody = balancedBody(stripped, stripped.indexOf("{", boxyScopeStart));
    const squared = new Set(
      flatRules(boxyBody)
        .filter((r) => /border-radius:\s*0\s*!important/.test(r.declarations))
        .flatMap((r) => r.selector.split(",").map((s) => s.trim())),
    );

    const offenders: string[] = [];
    const checkRadius = (selector: string, declarations: string) => {
      if (exempt.some((token) => selector.includes(token))) return;
      const decls = declarations.match(/border-[\w-]*radius\s*:\s*[^;]+;/g) ?? [];
      for (const decl of decls) {
        if (/:\s*0(px)?\s*;/.test(decl)) continue;
        if (![...squared].some((token) => selector.endsWith(token))) {
          offenders.push(`${selector} { ${decl.trim()} }`);
        }
      }
    };

    // Flat, skin-prefixed rules (e.g. `[data-skin="messenger"] [data-orbit-message-content]`).
    for (const { selector, declarations } of flatRules(stripped)) {
      if (selector.includes("[data-skin=")) checkRadius(selector, declarations);
    }

    // Rules nested in a per-skin `@scope ([data-skin="x"]) { ... }` block, whose
    // own selectors (e.g. `.chat-md blockquote`) never repeat the skin attribute.
    const scopeRe = /@scope\s*\(([^)]*)\)[^{]*\{/g;
    let m: RegExpExecArray | null;
    while ((m = scopeRe.exec(stripped))) {
      if (!m[1].includes("[data-skin=")) continue;
      const body = balancedBody(stripped, stripped.indexOf("{", m.index));
      for (const { selector, declarations } of flatRules(body)) {
        checkRadius(selector, declarations);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("skin persistence", () => {
  const store = new Map<string, string>();
  const dataset = { skin: "" };
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  const extras: { dataset: Record<string, string>; textContent: string; remove: () => void }[] = [];
  const head = {
    querySelector: (selector: string) => (selector === "style[data-skin-extra]" && extras.find((el) => "skinExtra" in el.dataset)) || null,
    append: (el: (typeof extras)[number]) => void extras.push(el),
  };
  const createElement = () => {
    const el = { dataset: {}, textContent: "", remove: () => void extras.splice(extras.indexOf(el), 1) };
    return el;
  };

  beforeEach(() => {
    store.clear();
    dataset.skin = "";
    extras.length = 0;
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", { documentElement: { dataset }, head, createElement });
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["desktop", "phone"])("tool detail opts in through config on %s and stays on after switching skins", async (surface) => {
    const fetch = vi.fn(async () => Response.json({}));
    const apply = vi.fn(async () => true);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", surface === "desktop" ? { ogb: { applySkin: apply } } : {});
    applySkin("ledger");
    expect(fetch).not.toHaveBeenCalled();
    applySkin("terminal");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ features: { toolDetailCapture: true } }),
    });
    applySkin("ledger");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readSkin()).toBe("ledger");
  });

  it.each(["terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal"] as const)("tool detail opts in for %s too", async (id) => {
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    applySkin(id);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    expect(readSkin()).toBe(id);
  });

  it("tool detail retries the opt-in when Terminal is restored after a failed request", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    applySkin("terminal");
    await Promise.resolve();
    applySkin(readSkin());
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("adds the tool skins' style tag only while one of them is on", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    applySkin("ledger");
    expect(extras).toHaveLength(0);
    for (const id of ["logfile", "multiplexer", "modal"] as const) {
      applySkin(id);
      expect(extras).toHaveLength(1);
    }
    applySkin("terminal");
    expect(extras).toHaveLength(0);
    applySkin("modal");
    applySkin("precision");
    expect(extras).toHaveLength(0);
  });

  it.each(["mono-hud", "servo-gray"] as const)("swaps the extra style tag between the tool skins and %s", (id) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    applySkin(id);
    expect(extras.map((el) => el.dataset.skinExtra)).toEqual(["mono-hud"]);
    applySkin("modal");
    expect(extras.map((el) => el.dataset.skinExtra)).toEqual(["tool"]);
    applySkin("precision");
    expect(extras).toHaveLength(0);
  });

  it("stamps data-skin and remembers the choice under omb-skin", () => {
    applySkin("ledger");
    expect(dataset.skin).toBe("ledger");
    expect(store.get("omb-skin")).toBe("ledger");
    expect(readSkin()).toBe("ledger");
  });

  it("remembers Peach and Coral and restores them for the next session", () => {
    for (const id of ["peach", "coral"] as const) {
      applySkin(id);
      expect(dataset.skin).toBe(id);
      expect(store.get("omb-skin")).toBe(id);
      expect(readSkin()).toBe(id);
    }
  });

  it("falls back to the default skin for removed Haxor and Seaglass", () => {
    for (const id of ["haxor-blue", "seaglass"]) {
      store.set("omb-skin", id);
      expect(readSkin()).toBe(DEFAULT_SKIN);
    }
  });

  it("remembers Pewter, Coal, and Folio", () => {
    for (const id of ["pewter", "pewter-dusk", "pewter-night", "coal", "folio"] as const) {
      applySkin(id);
      expect(dataset.skin).toBe(id);
      expect(store.get("omb-skin")).toBe(id);
      expect(readSkin()).toBe(id);
    }
  });

  it("remembers the Wink family", () => {
    for (const id of ["wink", "wink-cyber", "wink-violet", "wink-black", "wink-day"] as const) {
      applySkin(id);
      expect(dataset.skin).toBe(id);
      expect(store.get("omb-skin")).toBe(id);
      expect(readSkin()).toBe(id);
    }
  });

  it("falls back to Precision for an unknown stored value", () => {
    store.set("omb-skin", "boreal");
    expect(readSkin()).toBe("precision");
    expect(readSkin()).toBe(DEFAULT_SKIN);
  });

  it("uses Precision when nothing is saved", () => {
    expect(readSkin()).toBe("precision");
    expect(readSkin()).toBe(DEFAULT_SKIN);
  });

  it("keeps a stored Midnight skin on upgrade instead of migrating it to Precision", () => {
    store.set("omb-skin", "midnight");
    expect(readSkin()).toBe("midnight");
    expect(readSkin()).not.toBe(DEFAULT_SKIN);
  });

  it("records every applied skin once as tried", () => {
    applySkin("inkwell");
    applySkin("precision");
    applySkin("inkwell");
    expect(readTriedSkins()).toEqual(["inkwell", "precision"]);
    store.set("omb-skins-tried", "not json");
    expect(readTriedSkins()).toEqual([]);
  });

  it.each(["wink-violet", "wink-black", "pewter"] as const)("applies and restores %s", (id) => {
    applySkin(id);
    expect(dataset.skin).toBe(id);
    expect(readSkin()).toBe(id);
  });

  it("migrates a stored Catppuccin Mocha to Catppuccin Frappe", () => {
    store.set("omb-skin", "catppuccin-mocha");
    expect(readSkin()).toBe("catppuccin-frappe");
  });

  it("migrates TUI Commander and VGA to Slate and Smoke", () => {
    store.set("omb-skin", "tui-commander");
    expect(readSkin()).toBe("tui-slate");
    store.set("omb-skin", "tui-vga");
    expect(readSkin()).toBe("tui-smoke");
  });

  it("migrates a stored Moss to Merlot", () => {
    store.set("omb-skin", "moss");
    expect(readSkin()).toBe("merlot");
  });

  it("lists the same light skins as the desktop overlay", () => {
    const { skinThemeSource } = createRequire(import.meta.url)("../../electron/skin-overlay.cjs");
    for (const id of SKIN_IDS) {
      expect(LIGHT_SKIN_IDS.has(id) ? "light" : "dark", id).toBe(skinThemeSource(id));
    }
  });

  it("stamps the skin before React mounts", () => {
    const main = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../main.tsx"),
      "utf8",
    );
    const applyAt = main.indexOf("applySkin(readSkin())");
    const renderAt = main.indexOf("createRoot(");
    expect(applyAt).toBeGreaterThan(-1);
    expect(applyAt).toBeLessThan(renderAt);
  });
});

describe("Lagoon and Snow scene themes", () => {
  it("pairs Lagoon with Lagoon Night and Snow with Snow Night, Day light and Night dark", () => {
    for (const id of ["lagoon", "lagoon-night", "snow", "snow-night"] as const) expect(SKIN_IDS).toContain(id);
    expect(["lagoon", "lagoon-night", "snow", "snow-night"].filter((id) => LIGHT_SKIN_IDS.has(id as SkinId))).toEqual(["lagoon", "snow"]);
    expect(SKINS.find((skin) => skin.id === "lagoon-night")?.name).toBe("Lagoon Night");
    expect(SKINS.find((skin) => skin.id === "snow-night")?.name).toBe("Snow Night");
  });

  it("gives Lagoon Night the prototype's water palette", () => {
    const night = { app: "#0b242a", panel: "#081c21", raised: "#12323a", card: "#10303a", ink: "#e4f5f3", "ink-secondary": "#9fc2c0", accent: "#3ed6c8", "bubble-user": "#134a4b" };
    for (const [name, value] of Object.entries(night)) expect(cssToken("lagoon-night", `--color-${name}`), name).toBe(value);
  });

  it("dresses Snow in Wink Day's palette and Snow Night in Precision's, everywhere those skins are styled", () => {
    for (const [twin, base] of [["snow", "wink-day"], ["snow-night", "precision"]] as const) {
      const lists = [...css.matchAll(/[^{}]*\{/g)].map(([selector]) => selector).filter((selector) => selector.includes(`[data-skin="${base}"]`));
      expect(lists.length).toBeGreaterThan(2);
      for (const selector of lists) expect(selector, selector.trim()).toContain(`[data-skin="${twin}"]`);
      expect(tokensOf(twin)).toEqual(tokensOf(base));
    }
  });
});
