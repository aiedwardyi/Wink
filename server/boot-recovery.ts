// Crash clean-up the first chat list does not need. Turns and non-GET requests wait for it (startup-timing.ts).
import { recoverHandedMail } from "./mail-index.ts";
import { recoverQuickAsks } from "./quick-ask.ts";
import { startupTiming } from "./startup-timing.ts";
import type { Store } from "./store.ts";

export function deferBootRecovery(store: Store, followNewestTasks: () => void, timing: Pick<typeof startupTiming, "afterPaint" | "measure"> = startupTiming): void {
  timing.afterPaint("recovery", async () => {
    recoverHandedMail(store);
    followNewestTasks();
    timing.measure("quick asks", () => recoverQuickAsks(store));
  });
}
