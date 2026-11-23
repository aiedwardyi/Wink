import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { lostFacts, madeUp } from "./dream-check.ts";

const SCRIPT = fileURLToPath(new URL("./dream-check.ts", import.meta.url));
const memory = (...lines) => `# Memory\n\n${lines.join("\n")}\n`;
const NOTES = ["- Lives in Seoul (noted 2026-11-01)", "- Uses pnpm", "- Allergic to peanuts"];
const history = (...entries) => `# Memory history\n\n## 2026-11-23 03:00\n${entries.join("\n")}\n`;

describe("lostFacts", () => {
  it("finds the line a tidy dropped", () => {
    expect(lostFacts(memory(...NOTES), { memory: memory(NOTES[0], NOTES[2]), history: [], side: [] })).toEqual(["Uses pnpm"]);
  });

  it("counts a line the history records as moved", () => {
    const after = { memory: memory(NOTES[0], NOTES[2]), history: [history('- "Uses pnpm" replaced by "Uses pnpm 9", 2026-11-23 (duplicate)')], side: [] };
    expect(lostFacts(memory(...NOTES), after)).toEqual([]);
  });

  it("does not count the note a moved line was replaced by", () => {
    const after = { memory: memory(NOTES[0], NOTES[2]), history: [history('- "Uses npm" replaced by "Uses pnpm", 2026-11-23')], side: [] };
    expect(lostFacts(memory(...NOTES), after)).toEqual(["Uses pnpm"]);
  });

  it("counts a line kept in a side file", () => {
    expect(lostFacts(memory(...NOTES), { memory: memory(NOTES[0]), history: [], side: ["# Tools\n\n* Uses pnpm\n", "Allergic to  peanuts"] })).toEqual([]);
  });
});

describe("madeUp", () => {
  it("finds a line the tidy added", () => {
    expect(madeUp(memory(...NOTES), memory(...NOTES, "- Uses yarn"))).toEqual(["Uses yarn"]);
  });
});

describe("dream-check script", () => {
  const run = (copy, ...args) => {
    const tmp = mkdtempSync(join(homedir(), "tmp-"));
    // run as a user would: outside Vitest's data guard, with its throwaway data dir under the test home
    const { VITEST: _vitest, ...env } = process.env;
    return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, copy, ...args], { encoding: "utf8", env: { ...env, TMP: tmp, TEMP: tmp, TMPDIR: tmp } });
  };

  it("runs one real tidy on a copy and reports nothing lost", () => {
    const copy = mkdtempSync(join(homedir(), "orbit-copy-"));
    mkdirSync(join(copy, "workspaces", "bot-a"), { recursive: true });
    writeFileSync(join(copy, "bots.json"), JSON.stringify([{ id: "bot-a", name: "Alpha" }]));
    writeFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), memory("- Uses pnpm (noted 2026-11-01)", "- Lives in Seoul", "- Uses pnpm (noted 2026-11-20)"));
    const json = join(copy, "out.json");
    const result = run(copy, "--no-model", "--json", json);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [row] = JSON.parse(readFileSync(json, "utf8")).results;
    expect(row).toMatchObject({ name: "Alpha", result: "saved", moved: 1, linesBefore: 5, linesAfter: 4, lost: [], madeUp: [], conflicts: 0 });
    expect(readFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), "utf8")).toContain("(noted 2026-11-01)");
  });

  it("refuses the live ~/.orbit", () => {
    const live = join(homedir(), ".orbit");
    mkdirSync(join(live, "workspaces"), { recursive: true });
    const result = run(live, "--no-model");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is the live ~/.orbit; copy it first");
  });
});
