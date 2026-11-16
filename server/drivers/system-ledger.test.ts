import { describe, expect, it } from "vitest";

import { systemLedger } from "./system-ledger.ts";

describe("system ledger", () => {
  it("keeps unaccepted and unknown sessions on the full system", () => {
    const ledger = systemLedger();
    expect(ledger.prompt(null, "rules")).toBe("rules");
    expect(ledger.prompt("new", "rules")).toBe("rules");
    expect(ledger.prompt("new", "rules")).toBe("rules");
    expect(ledger.prompt("new", undefined)).toBeUndefined();
    ledger.record("accepted", "rules");
    expect(ledger.holds("accepted", "rules")).toBe(true);
    expect(ledger.prompt("accepted", "rules")).toBeUndefined();
    expect(ledger.holds("new", "rules")).toBe(false);
  });

  it("retains every changed rule and memory fact without repeating unchanged text", () => {
    const ledger = systemLedger(true);
    const rules = "Approval boundaries stay unchanged. ".repeat(100);
    const first = `${rules}\nOwner: Mina.\nBudget: 500 dollars.\nCrate: BLUE-19.`;
    const second = `${rules}\nOwner: Mina.\nBudget: 740 dollars.\nCrate: BLUE-19.`;
    ledger.record("accepted", first);
    const update = ledger.prompt("accepted", second)!;
    expect(update).toContain("Removed lines no longer apply; added lines are current");
    expect(update).toContain("[Removed:]\nBudget: 500 dollars.");
    expect(update).toContain("[Added:]\nBudget: 740 dollars.");
    expect(update).not.toContain(rules);
    expect(ledger.holds("accepted", second)).toBe(false);
    ledger.record("accepted", second);
    expect(ledger.holds("accepted", second)).toBe(true);
    expect(ledger.prompt("accepted", second)).toBeUndefined();
    expect(ledger.prompt("accepted", second.replace("BLUE-19", "RED-20"))).toContain("Crate: RED-20.");
  });

  it("resends after invalidation and when a full replacement is shorter", () => {
    const ledger = systemLedger(true);
    ledger.record("accepted", "old rule");
    expect(ledger.prompt("accepted", "new rule")).toBe("new rule");
    ledger.forget("accepted");
    expect(ledger.holds("accepted", "old rule")).toBe(false);
    expect(ledger.prompt("accepted", "old rule")).toBe("old rule");
  });

  it("resends large changes and never shares instructions between sessions", () => {
    const ledger = systemLedger(true);
    const previous = "old ".repeat(4_000);
    const current = "new ".repeat(4_000);
    ledger.record("a", previous);
    ledger.record("b", current);
    expect(ledger.prompt("a", current)).toBe(current);
    expect(ledger.prompt("b", current)).toBeUndefined();
    expect(ledger.prompt("a", previous)).toBeUndefined();
  });

  it("resends reordered instructions when a line diff cannot represent them", () => {
    const ledger = systemLedger(true);
    ledger.record("accepted", "First section\nSecond section");
    expect(ledger.prompt("accepted", "Second section\nFirst section")).toBe("Second section\nFirst section");
  });

  it("keeps a held system across a restart instead of resending it", () => {
    const rules = "Approval boundaries stay unchanged. ".repeat(100);
    const first = `${rules}\nOwner: Mina.\nBudget: 740 dollars.`;
    systemLedger(true, "restart-held").record("session", first);
    const restarted = systemLedger(true, "restart-held");
    expect(restarted.holds("session", first)).toBe(true);
    expect(restarted.prompt("session", first)).toBeUndefined();
    const update = restarted.prompt("session", first.replace("740", "790"))!;
    expect(update).toContain("[Added:]\nBudget: 790 dollars.");
    expect(update).not.toContain(rules);
    expect(systemLedger(false, "restart-held").prompt("session", first.replace("740", "790"))).toBe(first.replace("740", "790"));
    expect(systemLedger(true, "other-instance").prompt("session", first)).toBe(first);
  });

  it("resends after a restart when the last turn never settled or compacted", () => {
    const ledger = systemLedger(true, "restart-unsettled");
    ledger.record("crashed", "rules");
    ledger.begin("crashed");
    expect(ledger.prompt("crashed", "rules")).toBeUndefined();
    expect(systemLedger(true, "restart-unsettled").prompt("crashed", "rules")).toBe("rules");
    ledger.keep("crashed");
    expect(systemLedger(true, "restart-unsettled").prompt("crashed", "rules")).toBeUndefined();
    ledger.record("compacted", "rules");
    ledger.forget("compacted");
    expect(systemLedger(true, "restart-unsettled").prompt("compacted", "rules")).toBe("rules");
  });

  it("resends budgets moved between projects even when the status also changes", () => {
    const ledger = systemLedger(true);
    const rules = "Approval boundaries stay unchanged. ".repeat(100);
    const first = `${rules}\n## Project A\nBudget: 500 dollars.\n## Project B\nBudget: 740 dollars.\nStatus: draft.`;
    const second = `${rules}\n## Project A\nBudget: 740 dollars.\n## Project B\nBudget: 500 dollars.\nStatus: final.`;
    ledger.record("accepted", first);
    expect(ledger.prompt("accepted", second)).toBe(second);
  });
});
