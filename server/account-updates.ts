import { z } from "zod";
import type { InstanceConfigMap } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { RateLimitsMap, RateLimitsReport } from "./rate-limits-store.ts";
import type { createUsageRefresh } from "./usage-refresh.ts";

export function createAccountUsage(deps: {
  registry: ProviderRegistry; configs(): InstanceConfigMap; refresh: ReturnType<typeof createUsageRefresh>;
  rateLimits: RateLimitsMap; save(id: string, report: RateLimitsReport): void;
}) {
  return async (id: string) => {
    const instance = deps.registry.get(id);
    const config = deps.configs()[id];
    if (!instance?.account || instance.driverKind !== "claudeAgent" || !config || deps.registry.accountBlocked(id)) return;
    const result = await deps.refresh(instance.driverKind, { instanceId: id,
      cli: z.object({ cli: z.string().optional() }).catch({}).parse(config.config).cli,
      environment: config.environment, account: instance.account,
    }, deps.rateLimits.get(id));
    if (!result.report || deps.registry.get(id)?.account?.generation !== instance.account.generation || deps.registry.accountBlocked(id)) return;
    const current = deps.rateLimits.get(id);
    if (current && Date.parse(current.observedAt) > Date.parse(result.report.observedAt)) return;
    deps.rateLimits.set(id, result.report);
    deps.save(id, result.report);
  };
}

export function createAccountUpdates<T>(deps: {
  describe(): Promise<T[]>;
  publish(instances: T[]): void;
  usage(id: string): Promise<void>;
}) {
  let pending: Promise<void> | undefined;
  let changed = false;
  let queue = Promise.resolve();
  const usage = new Map<string, Promise<void>>();
  const push = (): Promise<void> => {
    changed = true;
    if (pending) return pending;
    // Login probes may be waiting on the lifecycle queue that requested this push.
    pending = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      while (changed) {
        changed = false;
        deps.publish(await deps.describe());
      }
    }).catch(() => { console.error("Account update could not be published"); })
      .finally(() => { pending = undefined; if (changed) void push(); });
    return pending;
  };
  return (id?: string) => {
    const published = push();
    if (!id) return published;
    const existing = usage.get(id);
    if (existing) return existing;
    const read = queue.then(() => published).then(() => deps.usage(id))
      .catch(() => { console.error("Account usage could not be refreshed"); })
      .then(() => push()).finally(() => { usage.delete(id); });
    usage.set(id, read);
    queue = read;
    return read;
  };
}
