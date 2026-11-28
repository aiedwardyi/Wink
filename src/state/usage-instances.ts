import { usageIdentity, usageIdentityChanged } from "../../shared/usage-identity";
import type { Action, InstanceInfo, RateLimitReport } from "./store-types";

const observations = new WeakMap<RateLimitReport, number>();

export function localUsageObservation(report: RateLimitReport, fallbackAge = Infinity): number {
  const known = observations.get(report);
  if (known !== undefined) return known;
  const observed = performance.now() - (report.ageMs ?? fallbackAge);
  observations.set(report, observed);
  return observed;
}

export function usageInstances(before: InstanceInfo[], after: InstanceInfo[], preserve = false): InstanceInfo[] {
  return after.map((instance) => {
    const previous = before.find((candidate) => candidate.instanceId === instance.instanceId);
    if (previous && usageIdentityChanged(previous.snapshot, instance.snapshot)) return { ...instance, rateLimits: undefined };
    if (instance.rateLimits) localUsageObservation(instance.rateLimits);
    const current = previous?.rateLimits;
    if (!preserve || !current || (instance.rateLimits && Date.parse(instance.rateLimits.observedAt) >= Date.parse(current.observedAt))) return instance;
    return { ...instance, rateLimits: current };
  });
}

export function usageReport(instance: InstanceInfo, action: Extract<Action, { type: "rateLimits" }>): InstanceInfo {
  if (instance.instanceId !== action.instanceId) return instance;
  if (action.identity !== undefined && action.identity !== usageIdentity(instance.snapshot)) return instance;
  if (instance.rateLimits && Date.parse(action.report.observedAt) < Date.parse(instance.rateLimits.observedAt)) return instance;
  localUsageObservation(action.report, 0);
  return { ...instance, rateLimits: action.report };
}
