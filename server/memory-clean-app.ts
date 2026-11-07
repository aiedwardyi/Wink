import type { ModelSelection, ProviderInstance, RateLimitWindow } from "./contracts.ts";
import { createMemoryClean, type MemoryCleanDeps } from "./memory-clean.ts";
import type { TextCall } from "./memory-clean-types.ts";
import { summaryInstance } from "./summary-instance.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";

type EngineDeps = {
  selection(botId: string): Promise<ModelSelection | null>;
  instances(): readonly ProviderInstance[];
  available(instanceId: string): boolean;
  usage(instanceId: string): readonly RateLimitWindow[];
  now?(): number;
};

export function memoryCleanEngine(deps: EngineDeps): MemoryCleanDeps["engine"] {
  const now = deps.now ?? Date.now;
  const eligible = async (instance: ProviderInstance) => {
    if (!["claudeAgent", "codex"].includes(instance.driverKind) || !instance.enabled || !instance.generateText || !supportsWorkspaceFiles(instance.driverKind) || !deps.available(instance.instanceId) ||
      deps.usage(instance.instanceId).some((window) => window.usedPercent > 80 && (window.resetsAt === null || window.resetsAt > now()))) return false;
    try {
      const snapshot = await instance.snapshot();
      return snapshot.state === "available" && snapshot.authenticated !== false && snapshot.accountAuthenticated !== false;
    } catch { return false; }
  };
  const textCall = (instance: ProviderInstance, model: string): TextCall => {
    const summary = summaryInstance(instance, model);
    return async (prompt, opts) => {
      let tokens: number | undefined;
      const text = await summary.generateText!(prompt, { ...opts, timeoutMs: opts?.timeoutMs ?? 120_000, model, ephemeral: true, lean: true, onUsage: (used) => { tokens = used; } });
      return { text, tokens };
    };
  };
  return async (botId) => {
    const selection = await deps.selection(botId);
    const instances = deps.instances();
    const own = instances.find((instance) => instance.instanceId === selection?.instanceId);
    if (!own || !selection || !await eligible(own)) return null;
    const propose = textCall(own, selection.model);
    const key = `${own.instanceId}:${selection.model}`;
    for (const other of instances) {
      if (other.driverKind !== own.driverKind && await eligible(other)) return { key, propose, recall: textCall(other, other.textModel ?? other.models.default) };
    }
    return { key, propose, recall: textCall(own, selection.model) };
  };
}

export function createAppMemoryClean(deps: Omit<MemoryCleanDeps, "engine"> & EngineDeps) {
  return createMemoryClean({ ...deps, engine: memoryCleanEngine(deps) });
}
