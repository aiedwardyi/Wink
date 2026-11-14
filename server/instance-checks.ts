// First run has no saved engine checks. Answer the engine list at once with "checking" rows and push
// it again as each check lands, so one slow CLI no longer holds back every row.
import type { ProviderRegistry } from "./harness/registry.ts";

type Rows = Awaited<ReturnType<ProviderRegistry["describeKnown"]>>;

export function createInstanceChecks(
  registry: Pick<ProviderRegistry, "describeKnown" | "describeCached" | "onProbed">,
  publish: (rows: Rows) => void,
) {
  let waiting = false;
  let landed = 0;
  let pushes = Promise.resolve();
  const push = () => { pushes = pushes.then(describe).then(publish).catch(() => {}); };
  const describe = async () => {
    const before = landed;
    const rows = await registry.describeKnown();
    waiting = rows.some((row) => row.snapshot.state === "checking");
    // Starts only the checks not already running.
    if (waiting) void registry.describeCached().catch(() => {});
    // A check that landed mid-read found waiting unset; push it now.
    if (waiting && landed !== before) push();
    return rows;
  };
  registry.onProbed(() => {
    landed += 1;
    if (waiting) push();
  });
  return { describe };
}
