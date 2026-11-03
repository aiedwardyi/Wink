import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { resolveAutomaticSelection } from "./automatic-selection.ts";
import type { ModelSelection } from "./contracts.ts";

const source = ts.createSourceFile("index.ts", readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["automaticCandidate", "liveAutomaticCandidate", "automaticRequirements", "resolvedBotSelection", "defaultSelection"];
const extracted = source.statements.flatMap((node) => {
  if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) return [node.getText(source)];
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text))) return [node.getText(source)];
  return [];
}).join("\n");

function fixture(bound = true) {
  const bot = { id: "bot", modelSelection: { instanceId: "claude", model: "picked", mode: "automatic" as const }, approvePeerComms: false };
  const instances = ["claude", "added"].map((instanceId) => ({
    instanceId, driverKind: "claudeAgent", enabled: true, models: { default: "picked" },
    adapter: { capabilities: { agentsMcp: true } }, ...(instanceId === "added" ? { account: { of: "claude" } } : {}),
  }));
  const availability = new Map(instances.map((instance) => [instance.instanceId, true]));
  const rates = new Map();
  const patch = vi.fn();
  const globals = { botAccounts: { hasPending: () => false, resolve: () => bound ? { ...bot.modelSelection, instanceId: "added", mode: "pinned" } : bot.modelSelection },
    registry: { get: (id: string) => instances.find((instance) => instance.instanceId === id) },
    automaticAvailability: availability, rateLimitsByInstance: rates, resolveAutomaticSelection,
    store: { patchBot: patch }, rememberAutomaticAvailability: () => {},
    describeInstances: async () => instances.map((instance) => ({ ...instance, accountOf: instance.account?.of, snapshot: { state: "available" }, capabilities: instance.adapter.capabilities })),
  };
  const context = runInNewContext(ts.transpile(`${extracted}\n({ resolvedBotSelection, defaultSelection });`, { target: ts.ScriptTarget.ES2022 }), globals) as {
    resolvedBotSelection: (record: typeof bot, task?: { lastInstanceId: string; lastModel: string }) => Promise<ModelSelection>;
    defaultSelection: () => Promise<ModelSelection>;
  };
  return { ...context, bot, instances, availability, rates, patch };
}

describe("server account selection paths", () => {
  it("resolves the local account before continuity and preserves lastInstanceId", async () => {
    const f = fixture();
    const task = { lastInstanceId: "claude", lastModel: "old" };
    await expect(f.resolvedBotSelection(f.bot, task)).resolves.toMatchObject({ instanceId: "added", mode: "pinned", model: "picked" });
    expect(task.lastInstanceId).toBe("claude");
    expect(f.patch).not.toHaveBeenCalled();
  });

  it.each(["auth", "capability"])("asks instead of falling back from a bound account's failed %s", async (reason) => {
    const f = fixture();
    if (reason === "auth") f.availability.set("added", false);
    else { f.bot.approvePeerComms = true; f.instances[1].adapter.capabilities.agentsMcp = false; }
    await expect(f.resolvedBotSelection(f.bot)).rejects.toThrow(/account|choose/i);
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("filters added accounts from both fresh and fallback server Auto paths", async () => {
    const f = fixture(false);
    f.rates.set("claude", { windows: [{ id: "seven_day", usedPercent: 100, resetsAt: null }] });
    expect((await f.defaultSelection()).instanceId).toBe("claude");
    f.availability.set("claude", false);
    const resolved = await f.resolvedBotSelection(f.bot);
    expect(resolved.instanceId).toBe("claude");
    expect(f.patch).not.toHaveBeenCalledWith("bot", expect.objectContaining({ modelSelection: expect.objectContaining({ instanceId: "added" }) }));
  });
});
