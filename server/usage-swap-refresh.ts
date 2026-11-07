import { z } from "zod";
import type { InstanceConfigMap, ProviderInstance } from "./contracts.ts";
import type { RateLimitsMap, RateLimitsReport } from "./rate-limits-store.ts";
import type { createUsageRefresh } from "./usage-refresh.ts";

export function createUsageSwapRefresh(deps: {
  registry: { get(id: string): Pick<ProviderInstance, "driverKind"> | null | undefined }; configs(): InstanceConfigMap; refresh: ReturnType<typeof createUsageRefresh>;
  rateLimits: RateLimitsMap; save(id: string, report?: RateLimitsReport): void;
}) {
  const epochs = new Map<string, number>();
  return (id: string, ready = true) => {
    const epoch = (epochs.get(id) ?? 0) + 1;
    epochs.set(id, epoch);
    deps.refresh.invalidate(id);
    deps.save(id);
    if (!ready) return Promise.resolve();
    return Promise.resolve().then(async () => {
      const instance = deps.registry.get(id);
      const config = deps.configs()[id];
      if (!instance || !config || epochs.get(id) !== epoch) return;
      const result = await deps.refresh(instance.driverKind, { instanceId: id,
        cli: z.object({ cli: z.string().optional() }).catch({}).parse(config.config).cli,
        environment: config.environment, account: config.account,
      });
      if (!result.report || epochs.get(id) !== epoch) return;
      const current = deps.rateLimits.get(id);
      if (current && Date.parse(current.observedAt) > Date.parse(result.report.observedAt)) return;
      deps.rateLimits.set(id, result.report);
      deps.save(id, result.report);
    }).catch(() => {});
  };
}
