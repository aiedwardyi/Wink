import { allocateTestHome, requireTestHome } from "../../companion/src/test-profile.ts";

export { requireTestHome as testHome };

export function createFixtureHome(prefix: string): string {
  requireTestHome();
  return allocateTestHome(prefix, process.env.WINK_VITEST_HOME_NONCE!);
}
