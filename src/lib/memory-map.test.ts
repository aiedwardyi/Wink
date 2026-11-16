import { describe, expect, it } from "vitest";

import { memoryMap } from "./memory-map";

const text = [
  "# Memory",
  "- [Reps content preferences](memory/reps-content-preferences.md) - self-contained questions + expected output, few tips",
  "- Reps sync broken? First check GoogleDriveFS is running on each PC (`ssh work`, Get-Process).",
  "- Learns best by sitting down to understand fundamentals, not just repetition (noted 2026-10-16)",
  "- Wants the bot to use their name in examples instead of 'i' (noted 2026-10-16)",
  "- Uses Tailscale with SSH mesh across laptop, home, work, and phone (noted 2026-10-19)",
  "- Feedback style: never say \"yes/that's right\" if wrong or partly wrong; lead with \"partly right\" (noted 2026-10-30)",
  "- Wants to understand architecture to help with system design (noted 2026-10-30)",
  "- Gets frustrated by fill-in-the-blank when they don't know the words (noted 2026-11-05)",
  "- Has a Samsung Galaxy S24 Ultra phone (noted 2026-11-06)",
  "- When Eddie learns a new concept/method, drill it immediately with fresh similar reps until locked in (noted 2026-11-06)",
].join("\n");

describe("memoryMap", () => {
  it("puts the newest three notes in Just learned and the rest of the facts in Long-term, newest first", () => {
    const map = memoryMap(text);
    expect(map.learned.map((each) => each.fact)).toEqual([
      "When Eddie learns a new concept/method, drill it immediately with fresh similar reps until locked in",
      "Has a Samsung Galaxy S24 Ultra phone",
      "Gets frustrated by fill-in-the-blank when they don't know the words",
    ]);
    expect(map.longTerm.map((each) => each.fact)).toEqual([
      "Wants to understand architecture to help with system design",
      "Uses Tailscale with SSH mesh across laptop, home, work, and phone",
      "Learns best by sitting down to understand fundamentals, not just repetition",
      "Reps sync broken? First check GoogleDriveFS is running on each PC (ssh work, Get-Process).",
    ]);
    expect(map.longTerm[1]!.at).toEqual(new Date(2026, 9, 19));
    expect(map.longTerm[3]!.at).toBeNull();
  });

  it("sends rules for the bot to Habits and topic file links to neither", () => {
    const map = memoryMap(text);
    expect(map.muscle.map((each) => each.fact.slice(0, 20))).toEqual(["Feedback style: neve", "Wants the bot to use"]);
    expect([...map.longTerm, ...map.learned, ...map.muscle].some((each) => each.fact.includes("memory/"))).toBe(false);
  });

  it("counts a bot save from chat as just learned", () => {
    const messages = [{ id: "s", role: "bot", kind: "activity", at: new Date(2026, 10, 7).getTime(), tool: { name: "memory.save", lines: ["- Uses Tailscale with SSH mesh across laptop, home, work, and phone (noted 2026-10-19)"] } }] as import("@/state/store").Message[];
    const map = memoryMap(text, messages);
    expect(map.learned[0]!.fact).toBe("Uses Tailscale with SSH mesh across laptop, home, work, and phone");
    expect(map.longTerm.some((each) => each.fact.startsWith("Uses Tailscale"))).toBe(false);
  });
});

const plain = [
  "# Pokkey memory: rules",
  "",
  "## Owner",
  "Prefers short answers, one breath per sentence (09-27)",
  "Never reply with recaps or background",
  "[Topic notes](memory/topic.md) - links stay in Knowledge",
  "<!-- keep this file trimmed -->",
  "| name | value |",
  "| --- | --- |",
  "```",
  "inside a fence",
  "```",
  "## Habits",
  "Checks the build before replying (noted 2026-11-08)",
  "- A bullet still counts",
].join("\n");

describe("memoryMap plain lines", () => {
  it("counts plain lines as facts but not headings, fences, tables, comments or the title", () => {
    const map = memoryMap(plain);
    expect(map.longTerm.map((each) => each.fact)).toEqual([
      "Checks the build before replying",
      "Prefers short answers, one breath per sentence (09-27)",
      "A bullet still counts",
    ]);
    expect(map.muscle.map((each) => each.fact)).toEqual(["Never reply with recaps or background"]);
    expect(map.longTerm[0]!.at).toEqual(new Date(2026, 10, 8));
  });

  it("keeps #-prose and ignores comment openers, other fence markers and list items inside fences and comments", () => {
    const text = ["# Memory", "#1 preference is concise answers", "```html", "<!--", "- sample item", "```", "Lives in London", "~~~~", "```", "code line", "~~~~", "Likes tea", "<!--", "- hidden item", "-->", "Ends here"].join("\n");
    expect(memoryMap(text).longTerm.map((each) => each.fact).sort()).toEqual(["#1 preference is concise answers", "Ends here", "Likes tea", "Lives in London"]);
  });
});
