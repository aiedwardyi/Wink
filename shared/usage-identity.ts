type Snapshot = { authenticated?: boolean; account?: string; accountIdentity?: string };

export function usageIdentity(snapshot: Snapshot): string | null | undefined {
  return snapshot.authenticated === false ? null : snapshot.accountIdentity ?? snapshot.account;
}

export function usageIdentityChanged(before: Snapshot, after: Snapshot): boolean {
  const previous = usageIdentity(before);
  const current = usageIdentity(after);
  return previous !== undefined && current !== undefined && previous !== current;
}
