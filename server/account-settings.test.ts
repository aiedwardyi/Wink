import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { AccountService } from "./accounts.ts";
import { DATA_DIR, instanceConfigs, loadConfig, saveConfig, type AppConfig } from "./config.ts";

const settings = await import("./account-settings.ts").catch(() => null);
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf('      const previousPerson = (cfg.profile?.name ?? "").trim();');
const end = source.indexOf('      if ((cfg.profile?.name ?? "").trim() !== previousPerson)', start);
const save = ts.transpileModule(`async function save() { ${source.slice(start, end)} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
let serial = 0;

describe("account settings recovery", () => {
  it.each([false, true])("rejects a disabled account base before saving Settings (external %s)", async (externalSecretStorage) => {
    const dir = join(DATA_DIR, `settings-${++serial}`);
    mkdirSync(dir, { recursive: true });
    const cfg: AppConfig = { instances: { claude: { driver: "claudeAgent" } } };
    const accounts = new AccountService(dir, () => instanceConfigs(cfg));
    await accounts.add("claude");
    saveConfig(cfg);
    const before = readFileSync(join(DATA_DIR, "config.json"), "utf8");
    const deps = { cfg, accounts, patch: { instances: { claude: { enabled: false } } }, externalSecretStorage,
      saveConfig, loadConfig, syncCredentialEnv() {}, validateAccountSettings: settings?.validateAccountSettings };
    const run = new Function(...Object.keys(deps), `${save}\nreturn save;`)(...Object.values(deps));
    await expect(run()).rejects.toThrow("Account base must be an enabled Claude or Codex instance");
    expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).toBe(before);
    expect(cfg.instances?.claude.enabled).toBeUndefined();
  });

  it("returns one error row from account routes after a bad boot load", async () => {
    const dir = join(DATA_DIR, `settings-${++serial}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "accounts.json"), '{"version":99}');
    const accounts = new AccountService(dir, () => ({}));
    const { createAccountRoutes } = await import("./account-routes.ts");
    const { Readable } = await import("node:stream");
    let output = "";
    const route = createAccountRoutes({ accounts } as Parameters<typeof createAccountRoutes>[0], { describeCached: async () => [] } as unknown as Parameters<typeof createAccountRoutes>[1]);
    await route(Readable.from([]) as unknown as Parameters<typeof route>[0], { writeHead() {}, end: (body: string) => { output = body; } } as unknown as Parameters<typeof route>[1], "GET", "/api/accounts");
    const rows = JSON.parse(output).accounts;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "stopped", snapshot: { state: "unavailable", reason: expect.stringContaining("accounts.json") } });
  });
});
