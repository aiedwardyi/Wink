import { describe, expect, it } from "vitest";

import { protectTranslationNames } from "./translation-names.ts";

describe("translation names", () => {
  it("restores exact Unicode and punctuation without treating name substrings as people", () => {
    const text = "Anniversary: @Ann, 이서연님, A+B [팀], Ann.";
    const protectedNames = protectTranslationNames(text, ["Ann", "이서연", "A+B [팀]", "Unmentioned"]);
    expect(protectedNames.text).toContain("Anniversary");
    expect(protectedNames.text).not.toContain("Unmentioned");
    expect(protectedNames.restore(protectedNames.text.replace(/>[^<>]*<\/name_/g, ">changed</name_"))).toBe(text);
  });

  it.each(["missing", "duplicate", "damaged"])("rejects %s markers", (kind) => {
    const protectedNames = protectTranslationNames("이서연", ["이서연"]);
    const result = kind === "missing" ? "Lee Seoyeon" : kind === "duplicate" ? protectedNames.text.repeat(2) : protectedNames.text.replace("</name_", "</broken_");
    expect(() => protectedNames.restore(result)).toThrow("translation changed name markers");
  });

  it("leaves unrelated text and marker-like source text alone", () => {
    const text = "<name_old_0>literal</name_old_0> ready";
    const protectedNames = protectTranslationNames(text, ["Unmentioned"]);
    expect(protectedNames.hasNames).toBe(false);
    expect(protectedNames.text).toBe(text);
    expect(protectedNames.restore("Ready")).toBe("Ready");
  });

  it("keys the cache by protected names rather than random markers or unmentioned members", () => {
    const text = "이서연, Mina";
    const first = protectTranslationNames(text, ["이서연"]);
    expect(first.cacheKey).toBe(protectTranslationNames(text, ["Unmentioned", "이서연"]).cacheKey);
    expect(first.cacheKey).not.toBe(protectTranslationNames(text, ["이서연", "Mina"]).cacheKey);
  });
});
