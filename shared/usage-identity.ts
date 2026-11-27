type Snapshot = { authenticated?: boolean; account?: string; accountIdentity?: string };

export function usageIdentity(snapshot: Snapshot): string | null | undefined {
  return snapshot.authenticated === false ? null : snapshot.accountIdentity ?? snapshot.account;
}

/** The sign-in an account row shows: its identity, "" for one it can't name, null when none. */
export function shownLogin(snapshot: Snapshot): string | null {
  return snapshot.authenticated === true ? snapshot.accountIdentity ?? snapshot.account ?? "" : null;
}

export function usageIdentityChanged(before: Snapshot, after: Snapshot): boolean {
  const previous = usageIdentity(before);
  const current = usageIdentity(after);
  return previous !== undefined && current !== undefined && previous !== current;
}
