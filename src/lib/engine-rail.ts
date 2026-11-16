// Featured engines and first-launch connection choices.
import { isRetiredEngineKind } from "../../shared/model-selection.ts";

// Friends featured rail — Claude, Codex, Grok, Antigravity, Meta Muse, matching
// the DEFAULT_FLEET order so the rail leads with the same engine selection does.
// Gemini API is not a rail engine: Gemini models live on Antigravity.
export const FRIENDS_DRIVER_ORDER = [
  "claudeAgent",
  "codex",
  "grokAgent",
  "antigravityAgent",
  "museAgent",
] as const;

export const FRIENDS_CLI_DRIVERS = new Set([
  "claudeAgent",
  "codex",
  "grokAgent",
  "antigravityAgent",
  "museAgent",
]);

const FRIENDS_DRIVERS = new Set<string>(FRIENDS_DRIVER_ORDER);

export function friendsDriverRank(driverKind: string | undefined): number {
  const index = FRIENDS_DRIVER_ORDER.indexOf(driverKind as (typeof FRIENDS_DRIVER_ORDER)[number]);
  return index === -1 ? FRIENDS_DRIVER_ORDER.length : index;
}

export function isFriendsEngine(
  instance: { driverKind?: string } | undefined,
): boolean {
  return FRIENDS_DRIVERS.has(instance?.driverKind ?? "");
}

export function isFriendsCliEngine(
  instance: { driverKind?: string } | undefined,
): boolean {
  return FRIENDS_CLI_DRIVERS.has(instance?.driverKind ?? "");
}

export function orderFriendsEngines<T>(instances: readonly T[]): T[] {
  return [...instances].sort((left, right) =>
    friendsDriverRank((left as { driverKind?: string }).driverKind)
    - friendsDriverRank((right as { driverKind?: string }).driverKind),
  );
}

export function splitFriendsEngines<T>(instances: readonly T[]): {
  friends: T[];
  rest: T[];
} {
  const friends: T[] = [];
  const rest: T[] = [];
  for (const instance of instances) {
    // SAFETY: the generic preserves the caller's row type; this split reads only driverKind.
    const row = instance as { driverKind?: string };
    if (isFriendsEngine(row)) friends.push(instance);
    else if (!isRetiredEngineKind(row.driverKind)) rest.push(instance);
  }
  return { friends: orderFriendsEngines(friends), rest };
}

// First launch with nothing connected: every shipped engine, in default-fleet
// order like the rail. An empty list means "not asked yet" so we do not flash
// this screen before /api/instances returns.
const STARTER_CONNECT_DRIVERS = ["claudeAgent", "codex", "grokAgent", "antigravityAgent", "museAgent"] as const;

export function isEmptyEngineLaunch(
  instances: readonly { driverKind?: string; snapshot?: { state?: string } }[],
): boolean {
  return instances.length > 0
    && !instances.some((instance) => instance.snapshot?.state === "checking"
      || instance.snapshot?.state === "available" && !isRetiredEngineKind(instance.driverKind));
}

export function starterConnectEngines<T>(instances: readonly T[]): T[] {
  const picked: T[] = [];
  for (const driverKind of STARTER_CONNECT_DRIVERS) {
    for (const instance of instances) {
      // SAFETY: the generic preserves the caller's row type; this pick reads only driverKind.
      if ((instance as { driverKind?: string }).driverKind === driverKind) picked.push(instance);
    }
  }
  return picked;
}

export function firstLaunchConnectInstances<T>(instances: readonly T[]): T[] {
  return starterConnectEngines(
    // SAFETY: the generic preserves the caller's row type; this filter reads only install.
    instances.filter((instance) => Boolean((instance as { install?: unknown }).install)),
  );
}
