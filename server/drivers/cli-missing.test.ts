import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderDriver } from "../contracts.ts";
import { resolveDataDir } from "../data-dir.ts";
import { refreshPathCache, resetPathCacheForTests } from "../env-path.ts";
import { testHome } from "../testing/test-home.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { createMspDriver } from "./msp/runtime.ts";

const MISSING = "wink-missing-engine-cli";
const MuseNativeDriver = createMspDriver({
  driverKind: "museAgent",
  displayName: "Meta Muse",
  models: { default: "muse-spark-1.3", options: [] },
  defaultCli: MISSING,
  nativeSource: "muse.msp",
  loginNote: "sign in",
  isAuthenticated: () => true,
});

describe("missing engine CLI", () => {
  it.each([ClaudeDriver, CodexDriver, GrokAgentDriver, AntigravityDriver, MuseNativeDriver].map((driver) => [driver.driverKind, driver] as const))(
    "%s reads as Not Installed on Usage, not Status unknown",
    async (_kind, driver) => {
      // SAFETY: every listed driver decodes its own config from decodeConfig.
      const typed = driver as ProviderDriver<unknown>;
      const instance = await typed.create({ instanceId: "missing", displayName: "Missing", environment: {}, enabled: true, config: typed.decodeConfig({ cli: MISSING }) });
      try {
        expect(await instance.snapshot()).toMatchObject({ state: "unavailable", cliMissing: true });
      } finally { await instance.dispose(); }
    },
  );

  it.skipIf(process.platform === "win32").each(BUILT_IN_DRIVERS.filter((driver) => driver.install).map((driver) => [driver.driverKind, driver] as const))(
    "%s finds its CLI installed after Wink started, without a restart",
    async (kind, driver) => {
      for (const dir of [join(testHome(), ".local"), join(testHome(), ".grok"), join(resolveDataDir("server/drivers/cli-missing.test.ts"), "path-cache.json")]) rmSync(dir, { recursive: true, force: true });
      resetPathCacheForTests();
      // SAFETY: every built-in CLI driver config carries cli.
      const typed = driver as ProviderDriver<{ cli: string }>;
      const config = typed.decodeConfig({});
      const instance = await typed.create({ instanceId: "fresh", displayName: "Fresh", environment: {}, enabled: true, config });
      try {
        expect(await instance.snapshot()).toMatchObject({ state: "unavailable", cliMissing: true });
        const file = join(testHome(), kind === "grokAgent" ? ".grok" : ".local", "bin", config.cli);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "#!/bin/sh\necho 1.5.15\n");
        chmodSync(file, 0o755);
        await refreshPathCache([config.cli]);
        expect(await instance.snapshot({ refresh: true })).toMatchObject({ state: "available" });
      } finally { await instance.dispose(); }
    },
  );
});
