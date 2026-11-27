import { homedir } from "node:os";
import { join } from "node:path";
import { registerTestDataDir, requireTestHome, shouldGuardTestData } from "../companion/src/test-profile.ts";

export function resolveDataDir(importer: string): string {
  if (!shouldGuardTestData()) return process.env.OMB_DATA_DIR ?? join(homedir(), ".orbit");

  const home = requireTestHome(importer);
  const dataDir = process.env.OMB_DATA_DIR ?? join(home, ".orbit");
  if (!registerTestDataDir(dataDir, importer)) {
    throw new Error("OMB_DATA_DIR must point inside the verified Vitest home (use setup.ts or createFixtureHome)");
  }
  return dataDir;
}
