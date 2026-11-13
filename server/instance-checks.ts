// First run has no saved engine checks. Answer the engine list at once with "checking" rows and push
// it again as each check lands, so one slow CLI no longer holds back every row.
import type { ProviderRegistry } from "./harness/registry.ts";

type Rows = Awaited<ReturnType<ProviderRegistry["describeKnown"]>>;

export function createInstanceChecks(
  registry: Pick<ProviderRegistry, "describeKnown" | "describeCached" | "onProbed">,
  publish: (rows: Rows) => void,
) {
  let waiting = false;
  let pushes = Promise.resolve();
  const describe = async () => {
    const rows = await registry.describeKnown();
    waiting = rows.some((row) => row.snapshot.state === "checking");
    // Starts only the checks not already running.
    if (waiting) void registry.describeCached().catch(() => {});
    return rows;
  };
  registry.onProbed(() => {
    if (waiting) pushes = pushes.then(describe).then(publish).catch(() => {});
  });
  return { describe };
}
