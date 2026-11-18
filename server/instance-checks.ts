// First run has no saved engine checks. Answer the engine list at once with "checking" rows and push
// it again as each check lands, so one slow CLI no longer holds back every row.
import type { ProviderRegistry } from "./harness/registry.ts";
import { startupTiming } from "./startup-timing.ts";

type Rows = Awaited<ReturnType<ProviderRegistry["describeKnown"]>>;

export function createInstanceChecks(
  registry: Pick<ProviderRegistry, "describeKnown" | "describeCached" | "describeSaved" | "entries" | "onProbed">,
  publish: (rows: Rows) => void,
  startup: Pick<typeof startupTiming, "beforeFirstPaint" | "waitFor"> = startupTiming,
) {
  let waiting = false;
  let landed = 0;
  let bootProbes: "pending" | "settled" | undefined;
  let pushes = Promise.resolve();
  const push = () => { pushes = pushes.then(describe).then(publish).catch(() => {}); };
  const describe = async () => {
    const before = landed;
    const rows = await registry.describeKnown();
    waiting = rows.some((row) => row.snapshot.state === "checking");
    // Startup schedules its own probe pass after paint.
    if (waiting && !startup.beforeFirstPaint()) void registry.describeCached().catch(() => {});
    if (waiting && landed !== before) push();
    return rows;
  };
  registry.onProbed(() => {
    landed += 1;
    if (waiting) { push(); return; }
    if (bootProbes !== "pending") return;
    pushes = pushes.then(() => {
      // Read a complete in-memory list without forcing a disk write per startup probe.
      const rows = registry.describeSaved();
      if (rows.length === registry.entries().length) publish(rows);
    }).catch(() => {});
  });
  return {
    describe() {
      if (!bootProbes) {
        bootProbes = "pending";
        void startup.waitFor("probes").then(() => { bootProbes = "settled"; });
      }
      return describe();
    },
  };
}
