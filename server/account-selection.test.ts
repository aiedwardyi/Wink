import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { resolveAutomaticSelection } from "./automatic-selection.ts";
import type { AccountService } from "./accounts.ts";
import { BotAccounts } from "./bot-accounts.ts";
import { sameModelSelection } from "../shared/model-selection.ts";
import { currentModel, replacedModelLine } from "../shared/replaced-models.ts";
import type { ModelSelection, ProviderInstance } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { BotRecord, Store } from "./store.ts";

const source = ts.createSourceFile("index.ts", readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["automaticCandidate", "liveAutomaticCandidate", "automaticRequirements", "resolvedBotSelection", "automaticBotSelection", "defaultSelection"];
const extracted = source.statements.flatMap((node) => {
  if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) return [node.getText(source)];
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text))) return [node.getText(source)];
  return [];
}).join("\n");

function fixture(useDefault = true) {
  const bot = { id: "bot", modelSelection: { instanceId: "claude", model: "picked", mode: "automatic" }, approvePeerComms: false } as BotRecord;
  const instances = ["claude", "added", "other", "codex"].map((instanceId) => ({
    instanceId, driverKind: instanceId === "codex" ? "codex" : "claudeAgent", enabled: true,
    models: { default: "picked", options: [{ id: "picked" }, { id: "claude-opus-5-5" }, { id: "old" }] },
    adapter: { capabilities: { agentsMcp: true, effortLevels: ["medium"] } },
    ...(["added", "other"].includes(instanceId) ? { account: { of: "claude" } } : {}),
  })) as unknown as ProviderInstance[];
  const availability = new Map(instances.map((instance) => [instance.instanceId, true]));
  const rates = new Map();
  const signedOut = new Set<string>();
  const patch = vi.fn((_id: string, changes: Partial<BotRecord>) => Object.assign(bot, changes));
  const append = vi.fn();
  const accounts = { defaultFor: (of: string) => useDefault && of === "claude" ? "added" : undefined,
    get: (id: string) => ["added", "other"].includes(id) ? { of: "claude", state: "ready" } : undefined,
    drains: {},
  } as unknown as AccountService;
  const registry = { get: (id: string) => instances.find((instance) => instance.instanceId === id),
    accountAvailable: (id: string) => instances.some((instance) => instance.instanceId === id) && availability.get(id) !== false,
    instances: () => instances, accountBlocked: () => false,
  } as unknown as ProviderRegistry;
  const botAccounts = new BotAccounts(accounts, registry, {} as Store, { captured: () => null });
  const globals = { accounts, botAccounts, registry,
    automaticAvailability: availability, rateLimitsByInstance: rates, resolveAutomaticSelection,
    providerSnapshots: { get: (id: string) => signedOut.has(id) ? { state: "available", authenticated: false } : undefined },
    store: { bot: () => bot, patchBot: patch, appendMessage: append }, currentModel, replacedModelLine, sameModelSelection, rememberAutomaticAvailability: () => {},
    describeInstances: async () => instances.map((instance) => ({ ...instance, accountOf: instance.account?.of,
      snapshot: { state: availability.get(instance.instanceId) === false ? "unavailable" : "available", ...(signedOut.has(instance.instanceId) ? { authenticated: false } : {}) },
      capabilities: instance.adapter.capabilities })),
  };
  const context = runInNewContext(ts.transpile(`${extracted}\n({ resolvedBotSelection, defaultSelection });`, { target: ts.ScriptTarget.ES2022 }), globals) as {
    resolvedBotSelection: (record: BotRecord, task?: { lastInstanceId: string; lastModel: string; threadId?: string }) => Promise<ModelSelection>;
    defaultSelection: () => Promise<ModelSelection>;
  };
  return { ...context, bot, instances, availability, rates, signedOut, patch, append };
}

describe("server account selection paths", () => {
  it("resolves the engine default after continuity without publishing its id", async () => {
    const f = fixture();
    const task = { lastInstanceId: "claude", lastModel: "picked" };
    await expect(f.resolvedBotSelection(f.bot, task)).resolves.toMatchObject({ instanceId: "added", mode: "automatic", model: "picked" });
    expect(task.lastInstanceId).toBe("claude");
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("maps old account continuity back to its engine before resolving the default", async () => {
    const f = fixture();
    const task = { lastInstanceId: "other", lastModel: "picked" };
    expect((await f.resolvedBotSelection(f.bot, task)).instanceId).toBe("added");
    expect(task.lastInstanceId).toBe("other");
  });

  it("starts a new bot on a signed-in engine when Claude reads signed out", async () => {
    const f = fixture(false);
    f.signedOut.add("claude");
    expect((await f.defaultSelection()).instanceId).toBe("codex");
    f.signedOut.add("codex");
    expect((await f.defaultSelection()).instanceId).toBe("claude");
  });

  it.each(["auth", "capability"])("lets Auto choose another engine when the default fails %s", async (reason) => {
    const f = fixture();
    if (reason === "auth") f.availability.set("added", false);
    else {
      f.bot.approvePeerComms = true;
      f.instances[1].adapter.capabilities.agentsMcp = false;
    }
    expect((await f.resolvedBotSelection(f.bot)).instanceId).toBe("codex");
    expect(f.patch.mock.calls[0]?.[1].modelSelection?.instanceId).toBe("codex");
  });

  it("keeps a pinned engine on its default and refuses unavailable defaults", async () => {
    const f = fixture();
    f.bot.modelSelection.mode = "pinned";
    expect((await f.resolvedBotSelection(f.bot)).instanceId).toBe("added");
    f.availability.set("added", false);
    await expect(f.resolvedBotSelection(f.bot)).rejects.toThrow(/account|choose/i);
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("refuses a pinned default that cannot run the bot's tools", async () => {
    const f = fixture();
    f.bot.modelSelection.mode = "pinned";
    f.bot.approvePeerComms = true;
    f.instances[1].adapter.capabilities.agentsMcp = false;
    await expect(f.resolvedBotSelection(f.bot)).rejects.toThrow(/account|choose/i);
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("uses only the default's limits for fresh Auto and never a non-default added account", async () => {
    const f = fixture();
    f.rates.set("added", { windows: [{ id: "seven_day", usedPercent: 100, resetsAt: null }] });
    expect((await f.defaultSelection()).instanceId).toBe("codex");
    f.rates.clear();
    f.rates.set("claude", { windows: [{ id: "seven_day", usedPercent: 100, resetsAt: null }] });
    expect((await f.defaultSelection()).instanceId).toBe("claude");
    f.availability.set("added", false);
    f.availability.set("codex", false);
    await expect(f.resolvedBotSelection(f.bot)).rejects.toThrow(/engine|account/i);
  });

  it.each([
    ["gpt-6.1-sol", "gpt-6.2-sol", "GPT-6.1 Sol was replaced by GPT-6.2 Sol"],
    ["gpt-6-astra", "gpt-6.2-astra", "GPT-6 Astra was replaced by GPT-6.2 Astra"],
  ])("sends a bot saved on %s as %s, with one plain line", async (saved, current, line) => {
    const f = fixture(false);
    f.bot.modelSelection = { instanceId: "codex", model: saved, mode: "pinned", effort: "high" };
    expect(await f.resolvedBotSelection(f.bot)).toEqual({ instanceId: "codex", model: current, mode: "pinned", effort: "high" });
    expect(f.patch).toHaveBeenCalledWith("bot", { modelSelection: { instanceId: "codex", model: current, mode: "pinned", effort: "high" } });
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append.mock.calls[0]![1]).toMatchObject({ role: "bot", kind: "activity", tool: { name: line } });
  });

  it("says nothing for a model that was never replaced", async () => {
    const f = fixture(false);
    f.bot.modelSelection = { instanceId: "codex", model: "gpt-6.2-sol", mode: "pinned" };
    await f.resolvedBotSelection(f.bot);
    expect(f.append).not.toHaveBeenCalled();
  });

  it.each(["pinned", "automatic"] as const)("writes one replacement notice for two first sends in %s mode", async (mode) => {
    const f = fixture(false);
    f.bot.modelSelection = { instanceId: "codex", model: "gpt-6-astra", mode, effort: "medium" };
    const results = await Promise.all(["first", "second"].map((threadId) => f.resolvedBotSelection({ ...f.bot }, {
      threadId, lastInstanceId: "codex", lastModel: "gpt-6.2-astra",
    })));
    expect(results).toEqual([f.bot.modelSelection, f.bot.modelSelection]);
    expect(f.append).toHaveBeenCalledExactlyOnceWith("first", {
      role: "bot", kind: "activity", tool: { name: "GPT-6 Astra was replaced by GPT-6.2 Astra", ok: true },
    });
    expect(f.patch).toHaveBeenCalledTimes(1);
  });

  it("returns the same pinned modelSelection object with no default", async () => {
    const f = fixture(false);
    f.bot.modelSelection.mode = "pinned";
    expect(await f.resolvedBotSelection(f.bot)).toBe(f.bot.modelSelection);
  });
});
