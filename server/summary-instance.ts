import type { ProviderInstance } from "./contracts.ts";

export function summaryInstance(instance: ProviderInstance, model: string): ProviderInstance {
  if (!instance.generateText) return instance;
  if (instance.driverKind === "antigravityAgent") return { ...instance, get textModel() { return instance.textModel ?? model; }, generateText: (prompt, opts) => instance.generateText!(prompt, { ...opts, fallbackModel: model }) };
  if (instance.driverKind !== "codex") return instance;
  return {
    ...instance,
    textModel: model,
    generateText: (prompt, opts) => instance.generateText!(prompt, { ...opts, model }),
  };
}
