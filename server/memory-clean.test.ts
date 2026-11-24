import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { cleanerSkip, errorCode, historyBlock, historyFile, nightSummarySchema, parseHistory, quizBlocks, runIdOf, sha8, type HistoryRun } from "./memory-clean.ts";
import { secretLike, secretValue, userTyping } from "./memory-pass.ts";
import { BASE_SENDS, S32_ROWS, SECRET_CASES, TOKEN_TALK_LIMITS } from "./testing/secret-cases.ts";

const CASES = Object.values(SECRET_CASES).flat().flatMap(([id, text]) => (text === null ? [] : [[id, text] as const]));
// single-line cases v3's line rule moved: secretValue, holdsValue, the shape rule without trailing symbols, basic auth
const V3_MISSES = [
  "S17a", "C4a", "C4d", "C5b", "C10b", "D3", "E4a", "E4b", "E4c", "E5e", "E6e", "E6f", "E7a", "E7d",
  "E7f", "E9c", "E9d", "E9e", "E9f", "E9g", "E9i", "E9j", "E9k", "E9l", "E9m", "E9n", "F17", "F18",
  "F19", "F20", "F21", "R1c", "R1f", "R2e", "R6a", "R6b", "R6c", "R6d", "R6e", "R6f", "R7a", "R7e",
  "R9b", "R9c", "R9f", "R10g", "G1a", "G1b", "G1c", "G1d", "G1e", "G1f", "G1g", "G1h", "G3a", "G3b",
  "G3c", "G3d", "G3e", "G3f", "G3h", "G5b", "G5c", "G6a", "H3a", "H3b", "H3c", "H3d", "H3e",
];
const sha = (value: ReadonlyArray<unknown>) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("cleanerSkip", () => {
  it("holds every review case, each judged as one note", () => {
    expect(CASES).toHaveLength(331);
    expect(CASES.filter(([, text]) => !cleanerSkip(text)).map(([id]) => id)).toEqual([]);
  });

  it("holds the 69 single-line cases v3 moved", () => {
    const single = new Map(CASES.filter(([, text]) => !text.includes("\n")));
    expect(V3_MISSES).toHaveLength(69);
    expect(V3_MISSES.filter((id) => !cleanerSkip(single.get(id)!))).toEqual([]);
  });

  it("judges a note whole: a label line's value on its indented line moves when read by line", () => {
    const note = "- Router login for the upstairs box\n  sunflowerfield";
    expect(note.split("\n").map(cleanerSkip)).toEqual([true, false]);
    expect(cleanerSkip(note)).toBe(true);
  });

  it("holds a trailing-symbol value, a Japanese label, a key word, a code by its digits and a basic-auth link", () => {
    for (const text of ["- Guest network is SunnyHarbor!", "- パスワードは sakura です", "- The spare key sits under the blue pot", "- Gym code is 4821", "- Backups go to sftp://ed:plumtree@nas.local"]) {
      expect(cleanerSkip(text)).toBe(true);
    }
  });

  it("still moves a cost note with no label and a plain note", () => {
    expect(cleanerSkip("- Daily spend limit is $5 for research runs")).toBe(false);
    expect(cleanerSkip("- Prefers short replies in the morning")).toBe(false);
  });

  it("keeps a skipped note out of the quiz", () => {
    const blocks = [{ path: "memory/home.md", lines: ["- Router login for the upstairs box", "  sunflowerfield", "- Plants need water on Sundays"] }, { path: "memory/keys.md", lines: ["- The spare key sits under the blue pot"] }];
    expect(quizBlocks(blocks)).toEqual([{ path: "memory/home.md", lines: ["- Plants need water on Sundays"] }]);
  });
});

describe("capture after the label split", () => {
  it("answers every review case byte for byte as base 9f2983532 did", () => {
    const capture = [...CASES.map(([id, text]) => [id, secretValue(text), secretLike(text), userTyping(text)]), ...S32_ROWS.map((row) => userTyping(row))];
    expect(sha(capture)).toBe("ca8ca8029b3fa06b5b80eef61da2e9958e1dc02c7238045b57a6d0fe5c9d8240");
    expect(sha([[...BASE_SENDS], [...TOKEN_TALK_LIMITS]])).toBe("f0033db9d824ef201d7db063f7bd5af30512f2da63f7da2291a72304b6ad69ba");
  });
});

describe("moves history", () => {
  const at = Date.UTC(2026, 10, 24, 3, 50);
  const run: HistoryRun = {
    runId: runIdOf("a1b2c3d4", "bot-a", at),
    pc: "a1b2c3d4",
    bot: "bot-a",
    at,
    files: ["MEMORY.md", "memory/launch.md"],
    beforeBytes: 21_000,
    afterBytes: 19_000,
    merged: 0,
    replaced: 0,
    moved: 2,
    notes: [{ op: "move", sha8: sha8("- Launch detail 1"), bytes: 18, target: "memory/launch.md" }, { op: "move", sha8: sha8("- Launch detail 2"), bytes: 18, target: "memory/launch.md" }],
  };

  it("names one file per PC and month", () => {
    expect(historyFile(at, "a1b2c3d4")).toBe("memory/cleaner-history/moves-2026-11-a1b2c3d4.md");
  });

  it("reads back exactly the run it wrote, with the app's run fields in the header", () => {
    expect(parseHistory(`# Moves\n\n${historyBlock(run)}`)).toEqual([run]);
  });

  it("reads a history file as data: a line that does not parse is left out, never run", () => {
    const text = [historyBlock(run), "- move deadbeef 5 ../../outside.md", "- run node evil.mjs", '- run: {"runId":"zz"}', "- retire 12345678 3 memory/launch.md"].join("\n");
    expect(parseHistory(text)).toEqual([{ ...run, notes: [...run.notes, { op: "retire", sha8: "12345678", bytes: 3, target: "memory/launch.md" }] }]);
    expect(() => historyBlock({ ...run, notes: [{ op: "move", sha8: "note text", bytes: 1, target: "memory/launch.md" }] })).toThrow();
  });
});

describe("night summary", () => {
  const row = {
    bot: "bot-a", night: 1, trap: false, result: "saved", linesBefore: 5, linesAfter: 4, bytesBefore: 100, bytesAfter: 80, tokensBefore: 34, tokensAfter: 27,
    proposed: 1, moved: 1, filed: 0, skipped: 2, lost: [], madeUp: [sha8("- Uses yarn")], quizAsked: 0, quizRight: 0, undoneBlocks: 0, conflicts: 0,
    error: null, errorSha: null, ms: 12, modelTokens: 0, filingTokens: 0,
  };
  const summary = { build: "9f2983532", model: false, nights: 1, spent: { fresh: 0, processed: 0 }, failed: 0, bots: [row] };

  it("takes counts, codes, bot ids and sha8s", () => {
    expect(nightSummarySchema.parse(summary)).toEqual(summary);
  });

  it("refuses any free string", () => {
    for (const bad of [{ ...row, name: "Alpha" }, { ...row, lost: ["Uses pnpm"] }, { ...row, bot: "Alpha bot" }, { ...row, error: "model token cap reached" }, { ...row, result: "saved: Uses pnpm" }]) {
      expect(nightSummarySchema.safeParse({ ...summary, bots: [bad] }).success).toBe(false);
    }
    expect(nightSummarySchema.safeParse({ ...summary, reply: "ok" }).success).toBe(false);
  });

  it("turns a failure into a code", () => {
    expect(["model token cap reached", "429 Too Many Requests", "claude exited 1", "EISDIR: illegal operation", "Unexpected token in JSON", "boom"].map(errorCode)).toEqual(["cap", "rate-limit", "engine", "io", "parse", "other"]);
  });
});
