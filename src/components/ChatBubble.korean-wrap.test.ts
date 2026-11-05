import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../styles.css"), "utf8");
const bubble = readFileSync(join(here, "ChatBubble.tsx"), "utf8");

describe("Korean words stay whole", () => {
  it("the base stylesheet keeps Korean words whole and still breaks long unbroken text", () => {
    const rule = /html:lang\(ko\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/word-break:\s*keep-all/);
    expect(rule).toMatch(/overflow-wrap:\s*break-word/);
  });

  it("bubble text keeps words whole even when the UI is English", () => {
    const content = /data-orbit-message-content\s*\n\s*className=\{cn\(\s*"([^"]*)"/.exec(bubble)?.[1] ?? "";
    expect(content).toContain("[overflow-wrap:break-word]");
    expect(content).toContain("break-keep");
  });
});
