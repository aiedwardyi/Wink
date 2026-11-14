// Handshake hosts (spawn + initialize, no model request) one engine at a time; only the engines the
// bots use plus the default, since all five idle hosts together run past 600 MB.
import type { ProviderInstance } from "./contracts.ts";

const IDLE_POLL_MS = 5_000;
const SETTLE_CAP_MS = 30_000;

export type WarmRow = { instanceId: string; snapshot: { state: string; authenticated?: boolean } };

export async function warmEngines(input: {
  rows: readonly WarmRow[];
  wanted: ReadonlySet<string>;
  instance: (id: string) => Pick<ProviderInstance, "enabled" | "prepare" | "driverKind"> | null;
  busy: () => boolean;
  /** Startup settled since the warm began waiting; see createRequestQuiet. */
  settled?: (since: number) => boolean;
  /** The pool's gates for a warm no user asked for. */
  admit?: (driverKind: string) => boolean;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<string[]> {
  // boot-probe's warm-off arm; not a user setting.
  if (process.env.WINK_PROBE_NO_WARM === "1") return [];
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
  const now = input.now ?? Date.now;
  const since = now();
  const warmed: string[] = [];
  for (const row of input.rows) {
    if (!input.wanted.has(row.instanceId) || row.snapshot.state !== "available" || row.snapshot.authenticated !== true) continue;
    while (input.busy() || (input.settled && !input.settled(since))) await wait(IDLE_POLL_MS);
    const instance = input.instance(row.instanceId);
    if (!instance?.enabled || !instance.prepare || (input.admit && !input.admit(instance.driverKind))) continue;
    const ok = await instance.prepare().then(() => true, (error: unknown) => {
      console.error(`[warm] ${row.instanceId} warm failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    if (ok) warmed.push(row.instanceId);
  }
  return warmed;
}

const signedIn = (row: WarmRow) => row.snapshot.state === "available" && row.snapshot.authenticated === true;

/** Warms engines that sign in after the boot warm; inert until `arm` gets the rows the boot warm saw. */
export function createSignInWarm(input: Omit<Parameters<typeof warmEngines>[0], "rows" | "wanted"> & { wanted: () => Promise<ReadonlySet<string>> }) {
  let ready: Set<string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    arm(rows: readonly WarmRow[]) { ready = new Set(rows.filter(signedIn).map((row) => row.instanceId)); },
    observe(rows: readonly WarmRow[]): Promise<string[]> | undefined {
      if (!ready) return;
      const flipped = rows.filter((row) => signedIn(row) && !ready!.has(row.instanceId));
      for (const row of rows) {
        if (signedIn(row)) ready.add(row.instanceId);
        else ready.delete(row.instanceId);
      }
      if (!flipped.length) return;
      const run = queue.then(async () => warmEngines({ ...input, rows: flipped, wanted: await input.wanted() })).catch((error: unknown) => {
        console.error(`[warm] sign-in warm failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      queue = run;
      return run;
    },
  };
}

/** Startup data and screens load through requests; warms start once none is open and the last ended `quietMs` ago,
 * or, past `capMs` of waiting, at any moment none is open, so a steady poll cannot hold a warm off forever. */
export function createRequestQuiet(now: () => number = Date.now, quietMs = 2_000, capMs = SETTLE_CAP_MS) {
  let open = 0;
  let last = now();
  return {
    track(): () => void {
      open++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        open--;
        last = now();
      };
    },
    settled: (since: number) => open === 0 && (now() - last >= quietMs || now() - since >= capMs),
  };
}

/** No-intent warms take one engine: the most recently used chat's, else the default. */
export function oneEngine(chats: readonly { instanceId: string; at: number | null }[], fallback: string): Set<string> {
  let latest: { instanceId: string; at: number | null } | undefined;
  for (const chat of chats) if (chat.at !== null && (!latest || chat.at > latest.at!)) latest = chat;
  return new Set([latest?.instanceId ?? fallback]);
}
