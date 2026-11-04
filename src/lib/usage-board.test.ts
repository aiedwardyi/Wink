import { describe, expect, it } from "vitest";

import type { UsageBoard } from "./usage-board";
import { usageBoardFixture, usageBoardNow } from "./usage-board.fixture";

describe("usage board fixture", () => {
  it("fixture type-checks and holds no identity canary", () => {
    const board: UsageBoard = usageBoardFixture;
    const local = ["identity", "canary", "local"].join("_");
    const domain = ["identity", "canary", "invalid"].join(".");
    const canary = `${local}@${domain}`;
    const text = JSON.stringify(board);
    for (const value of [local, domain, canary]) expect(text).not.toContain(value);
    expect(text).not.toContain("@");
    expect(board.version).toBe(1);
    expect(board.at).toBe(usageBoardNow);
  });

  it("fixture tells the concept O story", () => {
    const claude = usageBoardFixture.engines.find((engine) => engine.engine === "claude")!;
    const [main, limited, studio] = claude.accounts;
    expect(main).toMatchObject({ name: "Claude 1", main: true, id: claude.mainId });
    expect(main.bots.some((bot) => bot.busy)).toBe(true);
    expect(main.workers?.some((worker) => worker.state === "busy")).toBe(true);
    expect(limited).toMatchObject({ name: "Claude 2", coverage: "unknown" });
    expect(limited.windows[0].usedPercent).toBe(100);
    const reset = new Date(limited.windows[0].resetsAt!);
    expect([reset.getDay(), reset.getHours(), reset.getMinutes()]).toEqual([1, 17, 0]);
    expect(studio.name).toBe("Studio");
    expect(100 - studio.windows.find((window) => window.kind === "session")!.usedPercent).toBe(40);
    const codex = usageBoardFixture.engines.find((engine) => engine.engine === "codex")!.accounts[0];
    expect(codex).toMatchObject({ name: "Codex 1", coverage: "complete" });
    expect(codex.windows.map((window) => window.kind)).toEqual(["week"]);
    expect(codex.history.fine.every((point) => point[1] === null)).toBe(true);
    const grok = usageBoardFixture.engines.find((engine) => engine.engine === "grok")!.accounts[0];
    expect(grok).toMatchObject({ name: "Grok", observedAt: null, windows: [], coverage: "unknown", history: { fine: [], coarse: [] } });
    expect(main.history.fine).toHaveLength(288);
    expect(main.history.coarse).toHaveLength(168);
  });
});
