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
  let signedIn = new Map<string, boolean | undefined>();
  let pushes = Promise.resolve();
  const push = () => { pushes = pushes.then(describe).then(publish).catch(() => {}); };
  const describe = async () => {
    const before = landed;
    const rows = await registry.describeKnown();
    waiting = rows.some((row) => row.snapshot.state === "checking");
    signedIn = new Map(rows.map((row) => [row.instanceId, row.snapshot.authenticated]));
    // Starts only the checks not already running.
    if (waiting) void registry.describeCached().catch(() => {});
    // A check that landed mid-read found waiting unset; push it now.
    if (waiting && landed !== before) push();
    return rows;
  };
  registry.onProbed((id) => {
    landed += 1;
    if (waiting) return push();
    // A re-check answers only the window that asked; a changed sign-in must reach every open one.
    void registry.describeKnown().then((rows) => {
      const row = rows.find((candidate) => candidate.instanceId === id);
      if (row && signedIn.has(id) && row.snapshot.authenticated !== signedIn.get(id)) push();
    }).catch(() => {});
  });
  return { describe };
}
