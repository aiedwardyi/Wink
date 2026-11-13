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
  // boot-probe's warm-off arm; not a user setting.
  if (process.env.WINK_PROBE_NO_WARM === "1") return [];
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
  const warmed: string[] = [];
  for (const row of input.rows) {
    if (!input.wanted.has(row.instanceId) || row.snapshot.state !== "available" || row.snapshot.authenticated !== true) continue;
    while (input.busy()) await wait(IDLE_POLL_MS);
    const instance = input.instance(row.instanceId);
    if (!instance?.enabled || !instance.prepare) continue;
    if (await instance.prepare().then(() => true, () => false)) warmed.push(row.instanceId);
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
      const run = queue.then(async () => warmEngines({ ...input, rows: flipped, wanted: await input.wanted() })).catch(() => []);
      queue = run;
      return run;
    },
  };
}

/** Startup data and screens load through requests; warms start only once none is open and the last ended `quietMs` ago. */
export function createRequestQuiet(now: () => number = Date.now, quietMs = 2_000) {
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
    quiet: () => open === 0 && now() - last >= quietMs,
  };
}
