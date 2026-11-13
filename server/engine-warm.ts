// Handshake hosts (spawn + initialize, no model request) one engine at a time; only the engines the
// bots use plus the default, since all five idle hosts together run past 600 MB.
import type { ProviderInstance } from "./contracts.ts";

const IDLE_POLL_MS = 5_000;

export type WarmRow = { instanceId: string; snapshot: { state: string; authenticated?: boolean } };

export async function warmEngines(input: {
  rows: readonly WarmRow[];
  wanted: ReadonlySet<string>;
  instance: (id: string) => Pick<ProviderInstance, "enabled" | "prepare"> | null;
  busy: () => boolean;
  wait?: (ms: number) => Promise<void>;
}): Promise<string[]> {
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
  const warmed: string[] = [];
  for (const row of input.rows) {
    if (!input.wanted.has(row.instanceId) || row.snapshot.state !== "available" || row.snapshot.authenticated !== true) continue;
    while (input.busy()) await wait(IDLE_POLL_MS);
    const instance = input.instance(row.instanceId);
    if (!instance?.enabled || !instance.prepare) continue;
    await instance.prepare().catch(() => {});
    warmed.push(row.instanceId);
  }
  return warmed;
}
