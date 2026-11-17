import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { whatsNewGap } from "./check-whats-new.mjs";

const source = (...versions) => `export const WHATS_NEW = {\n${versions.map((v) => `  "${v}": {\n    title: {},\n  },\n`).join("")}};`;

describe("What's New release gate", () => {
  it("fails a release newer than every entry, naming the entry to add", () => {
    expect(whatsNewGap(source("1.0.246", "1.0.273"), "1.0.275")).toBe(`What's New is 1.0.273, older than 1.0.275: add a "1.0.275" entry to WHATS_NEW in src/lib/whats-new.ts`);
    expect(whatsNewGap(source("1.0.99"), "1.0.100")).not.toBeNull();
  });

  it("passes a release with its own entry or a newer one", () => {
    expect(whatsNewGap(source("1.0.273", "1.0.275"), "1.0.275")).toBeNull();
    expect(whatsNewGap(source("1.0.276", "1.0.100"), "1.0.275")).toBeNull();
  });

  it("covers the version this checkout would release", () => {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(whatsNewGap(readFileSync("src/lib/whats-new.ts", "utf8"), version)).toBeNull();
  });
});
