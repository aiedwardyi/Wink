import { describe, expect, it } from "vitest";

import { notedLines } from "./MemoryGroups";

describe("notedLines", () => {
  it("keeps only Auto notes lines, newest first", () => {
    const text = [
      "# Memory",
      "- Ships to review-base",
      "- Prefers pnpm (noted 2026-10-28)",
      "- Lives in Seoul (noted 2026-11-01)\r",
      "- Short answers (noted 2026-11-01)",
      "See memory/release.md (noted soon)",
    ].join("\n");
    expect(notedLines(text).map((line) => line.fact)).toEqual(["Short answers", "Lives in Seoul", "Prefers pnpm"]);
    expect(notedLines(text)[2]!.at).toEqual(new Date(2026, 9, 28));
  });
});
