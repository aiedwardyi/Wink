import { usageIdentity, usageIdentityChanged } from "../../shared/usage-identity";
import type { Action, InstanceInfo } from "./store-types";

export function usageInstances(before: InstanceInfo[], after: InstanceInfo[], preserve = false): InstanceInfo[] {
  return after.map((instance) => {
    const previous = before.find((candidate) => candidate.instanceId === instance.instanceId);
    if (previous && usageIdentityChanged(previous.snapshot, instance.snapshot)) return { ...instance, rateLimits: undefined };
    const current = previous?.rateLimits;
    if (!preserve || !current || (instance.rateLimits && Date.parse(instance.rateLimits.observedAt) >= Date.parse(current.observedAt))) return instance;
    return { ...instance, rateLimits: current };
  });
}

export function usageReport(instance: InstanceInfo, action: Extract<Action, { type: "rateLimits" }>): InstanceInfo {
  if (instance.instanceId !== action.instanceId) return instance;
  if (action.identity !== undefined && action.identity !== usageIdentity(instance.snapshot)) return instance;
  if (instance.rateLimits && Date.parse(action.report.observedAt) < Date.parse(instance.rateLimits.observedAt)) return instance;
  return { ...instance, rateLimits: action.report };
}
