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


describe("Recent saves", () => {
  it("includes bot saves still in the file and dedupes newest first", async () => {
    const { recentLines } = await import("@/lib/memory-recent");
    const messages = [
      { id: "a", role: "bot", at: 30, kind: "activity", tool: { name: "memory.save", spoken: "Bot", lines: ["- Bot", "- Gone"] } },
      { id: "b", role: "bot", at: 40, kind: "activity", tool: { name: "memory.save", spoken: "Bot..." } },
      { id: "c", role: "bot", at: 50, kind: "activity", tool: { name: "memory.save", tidy: { runId: "r" }, lines: ["- Ignore"] } },
    ] as import("@/state/store").Message[];
    expect(recentLines("- Bot  \n- Bot newest\n- Ignore", messages).map((row) => row.line)).toEqual(["- Bot newest", "- Bot"]);
  });
});

it("targets the summary's numbered line and falls back to the first line", async () => {
  const { memorySaveTarget } = await import("@/lib/memory-recent");
  expect(memorySaveTarget("Lives in Seoul", ["- Other", "1.\tLives in Seoul (noted 2026-11-04)"])).toBe("1.\tLives in Seoul (noted 2026-11-04)");
  expect(memorySaveTarget("Missing", ["- First", "- Second"])).toBe("- First");
});

it("keeps Auto notes filtering and does not retarget an edited explicit line", async () => {
  const { recentLines, memoryTargetLine } = await import("@/lib/memory-recent");
  expect(recentLines("# Header (noted 2026-11-04)\n- Fact (noted 2026-11-04)").map((row) => row.fact)).toEqual(["Fact"]);
  const messages = [{ id: "s", role: "bot", kind: "activity", at: 1, tool: { name: "memory.save", lines: ["Saved phrase"] } }] as import("@/state/store").Message[];
  expect(memoryTargetLine("Saved phrase edited", "Saved phrase", messages)).toBeUndefined();
  expect(memoryTargetLine("Saved phrase edited", "Saved phrase...")).toBe("Saved phrase edited");
});
