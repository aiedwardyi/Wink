import type { ProviderInstance } from "./contracts.ts";

export function summaryInstance(instance: ProviderInstance, model: string): ProviderInstance {
  if (instance.driverKind !== "codex" || !instance.generateText) return instance;
  return {
    ...instance,
    textModel: model,
    generateText: (prompt, opts) => instance.generateText!(prompt, { ...opts, model }),
  };
}
