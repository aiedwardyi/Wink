import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WHATS_NEW } from "../src/lib/whats-new";
import { whatsNewGap, whatsNewVersions } from "./check-whats-new.mjs";

const source = (...versions) => `export const WHATS_NEW = {\n${versions.map((v) => `  "${v}": {\n    title: {},\n  },\n`).join("")}};`;

describe("What's New release gate", () => {
  it("fails a release without its own entry, naming the entry to add", () => {
    expect(whatsNewGap(source("1.0.246", "1.0.273"), "1.0.275")).toBe(`What's New has no 1.0.275 entry, so 1.0.275 would show 1.0.273: add a "1.0.275" entry to WHATS_NEW in src/lib/whats-new.ts`);
    expect(whatsNewGap(source("1.0.273", "1.0.276"), "1.0.275"), "a newer entry is never shown on an older release").not.toBeNull();
  });

  it("passes a release with its own entry", () => {
    expect(whatsNewGap(source("1.0.273", "1.0.275"), "1.0.275")).toBeNull();
    expect(whatsNewGap(source("1.0.276", "1.0.100"), "1.0.100")).toBeNull();
  });

  it("reads every entry of the real WHATS_NEW", () => {
    expect(whatsNewVersions(readFileSync("src/lib/whats-new.ts", "utf8")).sort()).toEqual(Object.keys(WHATS_NEW).sort());
  });
});
