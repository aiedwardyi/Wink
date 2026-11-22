// Preloaded with --import into a harness boot: an async folder check of a path naming folder-check-hold waits for a
// FOLDER_CHECK_GATES/release file, and FOLDER_CHECK_GATES/held appears once it is waiting.
import fsp from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const gates = process.env.FOLDER_CHECK_GATES!;
const stat = fsp.stat;
// SAFETY: every argument goes to the real stat unchanged, so its overloads still hold.
fsp.stat = (async (...args: Parameters<typeof stat>) => {
  if (String(args[0]).includes("folder-check-hold")) {
    writeFileSync(join(gates, "held"), String(args[0]));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!existsSync(join(gates, "release"))) return;
        clearInterval(timer);
        resolve();
      }, 20);
    });
  }
  return stat(...args);
}) as typeof stat;
syncBuiltinESMExports();
