import type { InstanceInfo } from "@/state/store";

export type UsageAccount = InstanceInfo;

export function usageAccount(instances: InstanceInfo[], instanceId: string): UsageAccount | undefined {
  const selected = instances.find((instance) => instance.instanceId === instanceId);
  const account = selected?.accountOf && selected.accountOf !== instanceId ? selected
    : instances.find((instance) => instance.accountOf === instanceId && instance.accountMain) ?? selected;
  const drain = account?.drain;
  return drain && drain.phase !== "failed"
    ? instances.find((instance) => instance.instanceId === drain.destinationId) : account;
}

export function accountReady(account: UsageAccount): boolean {
  return account.snapshot.state === "available" && account.snapshot.authenticated === true
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
