import type { InstanceInfo } from "@/state/store";

export type UsageAccount = InstanceInfo;

export function engineAuthState(instance: Pick<InstanceInfo, "snapshot" | "access">) {
  const { state, authenticated } = instance.snapshot;
  if (state !== "available") return state;
  if (instance.access === "custom" || authenticated === true) return "ready";
  return authenticated === false ? "signed-out" : "checking";
}

export function usageAccount(instances: InstanceInfo[], instanceId: string): UsageAccount | undefined {
  const selected = instances.find((instance) => instance.instanceId === instanceId);
  const account = selected?.accountOf && selected.accountOf !== instanceId ? selected
    : instances.find((instance) => instance.accountOf === instanceId && instance.accountMain) ?? selected;
  const drain = account?.drain;
  return drain && drain.phase !== "failed"
    ? instances.find((instance) => instance.instanceId === drain.destinationId) : account;
}

export function setupEngine(instance: InstanceInfo, instances: InstanceInfo[]): InstanceInfo {
  const picker = instance.pickerSnapshot;
  if (!picker || instance.snapshot.state !== "available") return instance;
  const main = usageAccount(instances, instance.instanceId);
  const checking = picker.state === "checking" || (main !== undefined && main !== instance && engineAuthState(main) === "checking");
  return { ...instance, snapshot: { ...instance.snapshot, authenticated: checking ? undefined
    : picker.state === "available" ? picker.authenticated : false } };
}

export function accountReady(account: UsageAccount): boolean {
  return engineAuthState(account) === "ready"
    && (!account.accountState || account.accountState === "ready") && !account.drain;
}

export function groupAccounts(instances: InstanceInfo[]): UsageAccount[][] {
  const rows = new Map<string, UsageAccount[]>();
  for (const instance of instances) {
    const of = instance.accountOf ?? instance.instanceId;
    const group = rows.get(of) ?? [];
    group.push(instance);
    rows.set(of, group);
  }
  return [...rows.values()];
}
