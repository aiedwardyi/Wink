import { describe, expect, it } from "vitest";
import { readSource } from "./repo-check.mjs";
import { missingKoKeys } from "./check-ko-keys.mjs";

describe("Korean catalog gate", () => {
  it("rejects an English key missing from Korean", () => {
    expect(missingKoKeys('export const en = { "usage.used": "Used" } as const; export const ko = {};')).toEqual(["usage.used"]);
  });

  it("compares keys rather than key mentions in values or comments", () => {
    expect(missingKoKeys('const en = { used: "Used" }; const ko = { other: "used" }; // used')).toEqual(["used"]);
  });

  it("accepts matching catalogs with the repository type wrappers", () => {
    expect(missingKoKeys('const en = { "usage.used": "Used" } as const; const ko = { "usage.used": "사용" } satisfies Record<string, string>;')).toEqual([]);
  });

  it.each(['const en = {};', 'const en = { used: "Used" }; const ko = { ...en };'])
    ("fails closed on missing or nonliteral catalogs: %s", (source) => {
      expect(() => missingKoKeys(source)).toThrow();
    });

  it("accepts the repository catalogs", () => {
    expect(missingKoKeys(readSource("src/lib/i18n-catalog.ts"))).toEqual([]);
  });
});
