import { describe, expect, it } from "vitest";

import type { UsageBoard, UsageBoardAccount, UsageBoardWindow } from "../src/lib/usage-board.ts";
import { usageStatusText } from "./usage-status.ts";

const now = Date.UTC(2026, 10, 16, 5, 0);
const HOUR = 3_600_000;
const window = (kind: "session" | "week", usedPercent: number, resetsAt: number | null): UsageBoardWindow =>
  ({ id: kind === "session" ? "five_hour" : "seven_day", kind, usedPercent, resetsAt, windowMinutes: kind === "session" ? 300 : 10080 });
const account = (name: string, extra: Partial<UsageBoardAccount>): UsageBoardAccount => ({
  id: name, number: 1, nickname: null, name, main: false, signIn: "ready", coverage: "unknown", windows: [], observedAt: now - 3 * 60_000,
  history: { fine: [], coarse: [] }, bots: [], workers: null, ...extra,
});

const board: UsageBoard = {
  version: 1, revision: 1, cursor: "c", full: true, at: now, runs: "unknown",
  engines: [
    {
      engine: "claude", base: "claude", mainId: "Claude 1", events: [],
      accounts: [
        account("Claude 1", { main: true, windows: [window("session", 66, now + 2 * HOUR + 25 * 60_000), window("week", 41.4, now + 3 * 24 * HOUR + 19 * HOUR)] }),
        account("Work", { windows: [window("session", 100, now + 65 * 60_000), window("week", 80, now + 5 * 24 * HOUR)] }),
        account("Claude 3", { signIn: "signed-out", windows: [window("session", 10, now + HOUR)] }),
        account("Claude 4", { windows: [window("session", 100, now - 60_000)], observedAt: now - 6 * HOUR }),
      ],
    },
    { engine: "codex", base: "codex", mainId: "Codex 1", events: [], accounts: [account("Codex 1", { main: true, observedAt: null })] },
  ],
};

describe("usage_status text", () => {
  it("says what the Usage page shows for every account, as % left with absolute and relative resets", () => {
    expect(usageStatusText(board, "UTC").split("\n")).toEqual([
      "Usage page now (Mon, Nov 16, 05:00, UTC). Percent is what is LEFT.",
      "Claude:",
      "- Claude 1 (Main): 5h 34% left, resets Mon, Nov 16, 07:25 (in 2h 25m); 7d 59% left, resets Fri, Nov 20, 00:00 (in 3d 19h); reported 3m ago",
      "- Work: Limit reached; 5h 0% left, resets Mon, Nov 16, 06:05 (in 1h 5m); 7d 20% left, resets Sat, Nov 21, 05:00 (in 5d 0h); reported 3m ago",
      "- Claude 3: unavailable: signed out",
      "- Claude 4: 5h 0% left, reset passed (awaiting a fresh report); reported 6h 0m ago",
      "Codex:",
      "- Codex 1 (Main): no usage report yet",
      "Of the accounts with usage left, spend first the one whose window resets first.",
    ]);
  });

  it("gives reset clocks in the PC's time zone", () => {
    expect(usageStatusText(board, "Asia/Seoul")).toContain("- Claude 1 (Main): 5h 34% left, resets Mon, Nov 16, 16:25 (in 2h 25m)");
  });

  it("says so when no account is on the page", () => {
    expect(usageStatusText({ ...board, engines: [] }, "UTC")).toBe("No engine accounts on the Usage page yet.");
  });
});
