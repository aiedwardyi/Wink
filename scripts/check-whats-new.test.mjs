import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASE_NOTES } from "../src/lib/whats-new";
import { whatsNewGap, whatsNewVersions } from "./check-whats-new.mjs";

const source = (...versions) => `export const WHATS_NEW = {\n${versions.map((v) => `  "${v}": {\n    title: {},\n    tiles: [{}],\n  },\n`).join("")}};`;
const withNone = (record) => `export const WHATS_NEW = {\n  "1.0.273": {\n    title: {},\n    tiles: [{}],\n  },\n  "1.0.279": ${record},\n};`;

describe("What's New release gate", () => {
  it("fails a release without its own entry, naming the entry to add", () => {
    expect(whatsNewGap(source("1.0.246", "1.0.273"), "1.0.275")).toBe(`What's New has no 1.0.275 entry, so 1.0.275 would show 1.0.273: add a "1.0.275" entry to RELEASE_NOTES in src/lib/whats-new.ts`);
    expect(whatsNewGap(source("1.0.273", "1.0.276"), "1.0.275"), "a newer entry is never shown on an older release").not.toBeNull();
  });

  it("passes a release with its own entry", () => {
    expect(whatsNewGap(source("1.0.273", "1.0.275"), "1.0.275")).toBeNull();
    expect(whatsNewGap(source("1.0.276", "1.0.100"), "1.0.100")).toBeNull();
  });

  it("passes a release with an explicit no-tile record", () => {
    expect(whatsNewGap(withNone('{ tile: "none", reason: "Teammates asked for a quiet release." }'), "1.0.279")).toBeNull();
    expect(whatsNewGap(withNone('{\n    tile: "none",\n    reason: "Quiet release.",\n  }'), "1.0.279")).toBeNull();
  });

  it("fails an entry with neither a tile nor a no-tile record, naming the fix", () => {
    expect(whatsNewGap(withNone("{ title: {} }"), "1.0.279")).toBe(`What's New 1.0.279 has neither a tile nor a no-tile record: add tiles, or tile: "none" with a reason`);
    expect(whatsNewGap(withNone('{ tile: "none" }'), "1.0.279")).not.toBeNull();
    expect(whatsNewGap(withNone('{ tile: "none", reason: "" }'), "1.0.279")).not.toBeNull();
  });

  it("accepts every entry of the real WHATS_NEW", () => {
    const real = readFileSync("src/lib/whats-new.ts", "utf8");
    for (const version of Object.keys(RELEASE_NOTES)) expect(whatsNewGap(real, version), version).toBeNull();
  });

  it("reads every entry of the real WHATS_NEW", () => {
    expect(whatsNewVersions(readFileSync("src/lib/whats-new.ts", "utf8")).sort()).toEqual(Object.keys(RELEASE_NOTES).sort());
  });
});
