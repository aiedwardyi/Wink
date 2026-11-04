import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "./contracts.ts";
import { memoryCleanEngine } from "./memory-clean-app.ts";

function instance(driverKind: string, state = "available", authenticated = true) {
  return {
    instanceId: driverKind, driverKind, enabled: true, models: { default: "default" },
    snapshot: vi.fn(async () => ({ state, authenticated })), generateText: vi.fn(async () => "reply"),
  } as unknown as ProviderInstance;
}

describe("memory cleanup engines", () => {
  it("aborts cleanup when a dispatch claim succeeds before turn preparation", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    const node = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "tryClaimTurnStart")!;
    const compiled = ts.transpileModule(node.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const turnStartClaims = new Map(); const memoryClean = { turnStarted: vi.fn() };
    const claim = new Function("turnStartClaims", "memoryClean", `${compiled}\nreturn tryClaimTurnStart;`)(turnStartClaims, memoryClean);
    expect(claim("b", "t")).toBe(true); expect(memoryClean.turnStarted).toHaveBeenCalledTimes(1);
    expect(claim("b", "t")).toBe(false); expect(memoryClean.turnStarted).toHaveBeenCalledTimes(1);
  });
  it.each(["claudeAgent", "codex", "antigravityAgent", "grokAgent", "museAgent"])("passes the bot model and text options to %s", async (kind) => {
    const own = instance(kind);
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: kind, model: "chosen" }), instances: () => [own], available: () => true, usage: () => [] })("b");
    const signal = new AbortController().signal;
    expect(engine).not.toBeNull();
    await engine!.propose("proposal", { signal, timeoutMs: 123 });
    await engine!.recall("fresh", { signal });
    expect(own.generateText).toHaveBeenNthCalledWith(1, "proposal", { signal, timeoutMs: 123, model: "chosen", ephemeral: true, lean: true });
    expect(own.generateText).toHaveBeenNthCalledWith(2, "fresh", { signal, timeoutMs: 120000, model: "chosen", ephemeral: true, lean: true });
  });

  it("uses another signed-in family for blind answers", async () => {
    const own = instance("codex"); const signedOut = instance("claudeAgent", "unavailable", false); const other = instance("grokAgent");
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: "codex", model: "chosen" }), instances: () => [own, signedOut, other], available: () => true, usage: () => [] })("b");
    await engine!.propose("proposal"); await engine!.recall("blind");
    expect(own.generateText).toHaveBeenCalledTimes(1); expect(other.generateText).toHaveBeenCalledTimes(1); expect(signedOut.generateText).not.toHaveBeenCalled();
  });

  it.each(["signed-out", "disabled", "no-workspace", "usage", "account", "missing-selection"])("skips %s without a text call", async (kind) => {
    const own = instance(kind === "no-workspace" ? "boxAgent" : "codex", kind === "signed-out" ? "unavailable" : "available", kind !== "signed-out");
    if (kind === "disabled") Object.defineProperty(own, "enabled", { value: false });
    const engine = await memoryCleanEngine({ selection: async () => kind === "missing-selection" ? null : ({ instanceId: own.instanceId, model: "chosen" }), instances: () => [own], available: () => kind !== "account", usage: () => kind === "usage" ? [{ id: "week", usedPercent: 81, resetsAt: null }] : [] })("b");
    expect(engine).toBeNull(); expect(own.generateText).not.toHaveBeenCalled();
  });
});
