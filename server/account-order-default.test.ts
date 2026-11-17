import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { UsageBoard, UsageBoardAccount } from "../src/lib/usage-board.ts";
import { CODE_FIX_INSTRUCTIONS } from "./code-fix-rules.ts";
import { loadHarnessPlaybook, modelPicksPrompt } from "./harness-playbook.ts";
import { usageStatusText } from "./usage-status.ts";

const now = Date.UTC(2026, 10, 17, 5, 0);
const HOUR = 3_600_000;
const account = (name: string, main: boolean, resetsAt: number): UsageBoardAccount => ({
  id: name, number: 1, nickname: null, name, main, signIn: "ready", coverage: "unknown", observedAt: now, history: { fine: [], coarse: [] }, bots: [], workers: null,
  windows: [{ id: "five_hour", kind: "session", usedPercent: 10, resetsAt, windowMinutes: 300 }],
});
const board: UsageBoard = {
  version: 1, revision: 1, cursor: "c", full: true, at: now, runs: "unknown",
  engines: [{ engine: "claude", base: "claude", mainId: "Main one", events: [], accounts: [account("Main one", true, now + 4 * HOUR), account("Soon", false, now + HOUR)] }],
};

const BY_RESET_TIME = /spend first|resets? first|soonest|expires? first|earliest reset/i;

describe("accounts follow the user's order", () => {
  it("tells no bot to prefer the account that resets soonest", () => {
    const defaults = {
      usage_status: usageStatusText(board, "UTC"),
      playbook: loadHarnessPlaybook(),
      picks: modelPicksPrompt(),
      codeFix: CODE_FIX_INSTRUCTIONS,
      basePrompt: readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
    };
    for (const [name, text] of Object.entries(defaults)) expect(text, name).not.toMatch(BY_RESET_TIME);
  });

  it("keeps the Main marker and the user's order in usage_status, and says to use them", () => {
    const lines = usageStatusText(board, "UTC").split("\n");
    expect(lines.slice(2, 4).map((line) => line.split(":")[0])).toEqual(["- Main one (Main)", "- Soon"]);
    expect(lines.at(-1)).toMatch(/Main/);
    expect(lines.at(-1)).toMatch(/Settings order/);
  });
});
