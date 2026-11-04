import { enableWorkerAccounts } from "./worker-panes.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";
import { startupTiming } from "./startup-timing.ts";

export async function restoreStartupAccounts(access: TerminalBridgeAccess | null, restore: () => Promise<void>): Promise<void> {
  await startupTiming.track("workerRouting", () => enableWorkerAccounts(access))
    .catch(() => console.error("Worker account routing is unavailable at startup"));
  await restore();
}
