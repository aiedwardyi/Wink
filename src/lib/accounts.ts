import type { InstanceInfo } from "@/state/store";

export type UsageAccount = InstanceInfo;

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
