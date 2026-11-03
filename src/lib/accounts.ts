import { useCallback, useEffect, useState } from "react";
import { api, type InstanceInfo } from "@/state/store";

export interface AccountInfo {
  id: string;
  of: string;
  default?: boolean;
  state: "pending" | "ready" | "stopped";
  snapshot?: InstanceInfo["snapshot"];
  drain?: { destinationId: string; phase: "draining" | "logout" | "signed-out" | "failed" };
}

export interface UsageAccount extends InstanceInfo {
  accountInfo?: AccountInfo;
}

export function accountReady(account: UsageAccount): boolean {
  return account.snapshot.state === "available" && account.snapshot.authenticated === true
    && (!account.accountInfo || account.accountInfo.state === "ready") && !account.accountInfo?.drain;
}

export function useAccounts(instances: InstanceInfo[]) {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const reload = useCallback(async () => {
    const result = await api("/api/accounts");
    setAccounts(result.accounts ?? []);
  }, []);
  useEffect(() => {
    let live = true;
    void api("/api/accounts").then((result) => {
      if (live) setAccounts(result.accounts ?? []);
    }).catch(() => {});
    return () => { live = false; };
  }, [instances]);
  const rows = new Map<string, UsageAccount[]>();
  for (const instance of instances) {
    const info = accounts.find((account) => account.id === instance.instanceId);
    const of = info?.of ?? instance.instanceId;
    const group = rows.get(of) ?? [];
    group.push({ ...instance, snapshot: info?.snapshot ?? instance.snapshot, accountInfo: info });
    rows.set(of, group);
  }
  return { groups: [...rows.values()], reload };
}
