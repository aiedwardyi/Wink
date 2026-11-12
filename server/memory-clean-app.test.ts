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
  it.each(["claudeAgent", "codex"])("passes the bot model and text options to %s", async (kind) => {
    const own = instance(kind);
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: kind, model: "chosen" }), instances: () => [own], available: () => true, usage: () => [] })("b");
    const signal = new AbortController().signal;
    expect(engine).not.toBeNull();
    await engine!.propose("proposal", { signal, timeoutMs: 123 });
    await engine!.recall("fresh", { signal });
    expect(own.generateText).toHaveBeenNthCalledWith(1, "proposal", { signal, timeoutMs: 123, model: "chosen", ephemeral: true, lean: true, onUsage: expect.any(Function) });
    expect(own.generateText).toHaveBeenNthCalledWith(2, "fresh", { signal, timeoutMs: 120000, model: "chosen", ephemeral: true, lean: true, onUsage: expect.any(Function) });
  });

  it("uses another signed-in family for blind answers", async () => {
    const own = instance("codex"); const signedOut = instance("claudeAgent", "unavailable", false); const other = instance("claudeAgent");
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: "codex", model: "chosen" }), instances: () => [own, signedOut, other], available: () => true, usage: () => [] })("b");
    await engine!.propose("proposal"); await engine!.recall("blind");
    expect(own.generateText).toHaveBeenCalledTimes(1); expect(other.generateText).toHaveBeenCalledTimes(1); expect(signedOut.generateText).not.toHaveBeenCalled();
  });

  it.each(["grokAgent", "antigravityAgent", "museAgent"])("skips ungated proposer %s", async (kind) => {
    const own = instance(kind);
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: kind, model: "chosen" }), instances: () => [own], available: () => true, usage: () => [] })("b");
    expect(engine).toBeNull(); expect(own.generateText).not.toHaveBeenCalled();
  });

  it("skips ungated answerers before Codex", async () => {
    const own = instance("claudeAgent"); const grok = instance("grokAgent"); const other = instance("codex");
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: "claudeAgent", model: "chosen" }), instances: () => [own, grok, other], available: () => true, usage: () => [] })("b");
    await engine!.recall("blind");
    expect(other.generateText).toHaveBeenCalledTimes(1); expect(grok.generateText).not.toHaveBeenCalled();
  });

  it.each(["claudeAgent", "codex"])("returns %s usage with the text and keeps the latest cumulative report", async (kind) => {
    const own = instance(kind);
    own.generateText = vi.fn(async (_prompt, opts) => { opts?.onUsage?.({ input: 18_000, output: 500 }); opts?.onUsage?.({ input: 18_000, output: 908 }); opts?.onUsage?.(undefined); return "reply"; });
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: kind, model: "chosen" }), instances: () => [own], available: () => true, usage: () => [] })("b");
    expect(await engine!.propose("proposal")).toEqual({ text: "reply", tokens: 18_908 });
    expect(await engine!.recall("blind")).toEqual({ text: "reply", tokens: 18_908 });
  });

  it("leaves missing usage absent for the budget fallback", async () => {
    const own = instance("codex");
    const engine = await memoryCleanEngine({ selection: async () => ({ instanceId: "codex", model: "chosen" }), instances: () => [own], available: () => true, usage: () => [] })("b");
    expect(await engine!.propose("proposal")).toEqual({ text: "reply", tokens: undefined });
  });

  it.each(["signed-out", "disabled", "no-workspace", "usage", "account", "missing-selection"])("skips %s without a text call", async (kind) => {
    const own = instance(kind === "no-workspace" ? "boxAgent" : "codex", kind === "signed-out" ? "unavailable" : "available", kind !== "signed-out");
    if (kind === "disabled") Object.defineProperty(own, "enabled", { value: false });
    const engine = await memoryCleanEngine({ selection: async () => kind === "missing-selection" ? null : ({ instanceId: own.instanceId, model: "chosen" }), instances: () => [own], available: () => kind !== "account", usage: () => kind === "usage" ? [{ id: "week", usedPercent: 81, resetsAt: null }] : [] })("b");
    expect(engine).toBeNull(); expect(own.generateText).not.toHaveBeenCalled();
  });
});
