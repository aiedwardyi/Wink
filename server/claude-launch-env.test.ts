import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCH = /\b(?:spawnCli|execCli|spawn|execFile|execFileSync|spawnSync|execSync|fork)\(/g;
const FIX = "build the Claude pane env with withClaudePaneEnv() from shared/claude-launch-env.mjs";

// Every process launch in shipped code. `claude` is text in the file that shows its Claude pane env goes through withClaudePaneEnv.
const SITES = {
  "electron/terminal-host.mjs": { launches: 4, claude: "withClaudePaneEnv(" },
  "electron/terminal-remote.mjs": { launches: 1, claude: "CLAUDE_PANE_ENV" },
  // Headless Claude: Code Mode only runs in the interactive terminal.
  "server/drivers/claude.ts": { launches: 2 },
  "server/drivers/claude-fork.ts": { launches: 1 },
  // Control requests only, never a model turn.
  "server/claude-usage-probe.ts": { launches: 1 },
  "companion/src/listener.ts": { launches: 1 },
  "electron/build-speech-helper.mjs": { launches: 4 },
  "electron/companion.mjs": { launches: 1 },
  "electron/cua.mjs": { launches: 2 },
  "electron/main.mjs": { launches: 2 },
  "electron/map-base.mjs": { launches: 1 },
  "electron/pane-cleanup.mjs": { launches: 1 },
  "electron/server-boot-probe.mjs": { launches: 1 },
  "electron/speech.mjs": { launches: 1 },
  "electron/terminal-pty.mjs": { launches: 1 },
  "electron/verify-host.mjs": { launches: 2 },
  "server/device-sync.ts": { launches: 1 },
  "server/drivers/acp/core.ts": { launches: 2 },
  "server/drivers/acp/muse.ts": { launches: 1 },
  "server/drivers/antigravity.ts": { launches: 3 },
  "server/drivers/cli-text.ts": { launches: 1 },
  "server/drivers/codex-account.ts": { launches: 1 },
  "server/drivers/codex-catalog.ts": { launches: 1 },
  "server/drivers/codex-fork.ts": { launches: 1 },
  "server/drivers/codex-text.ts": { launches: 1 },
  "server/drivers/codex.ts": { launches: 4 },
  "server/drivers/msp/runtime.ts": { launches: 2 },
  "server/drivers/phone-proxy.ts": { launches: 1 },
  "server/engine-login.ts": { launches: 1 },
  "server/env-path.ts": { launches: 2 },
  "server/map-git.ts": { launches: 1 },
  "server/map-pr.ts": { launches: 1 },
  "server/mcp-bridge.ts": { launches: 2 },
  "server/procs.ts": { launches: 7 },
  "server/remote-access.ts": { launches: 1 },
  "server/tailscale-setup.ts": { launches: 1 },
  "server/usage-refresh.ts": { launches: 5 },
  "server/vps-computer.ts": { launches: 2 },
  "server/wsl-gate.ts": { launches: 2 },
} satisfies Record<string, { launches: number; claude?: string }>;
const sites = new Map<string, { launches: number; claude?: string }>(Object.entries(SITES));

function shipped(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name) && !/\.(?:test|node-test)\.|\.d\.mts$/.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .filter((file) => !file.includes("/testing/") && !file.includes("/node_modules/"));
}

// Child processes that may hold the user's own keys: their user-set MCP servers, and Wink's own sync worker.
const RAW_ENV = new Map([["server/mcp-bridge.ts", 2], ["server/thread-sync-v2.ts", 1]]);

it("helper CLIs start without saved keys", () => {
  const problems: string[] = [];
  for (const file of shipped("server")) {
    const count = readFileSync(join(ROOT, file), "utf8").match(/\benv: \{ ?\.\.\.process\.env\b/g)?.length ?? 0;
    if (count !== (RAW_ENV.get(file) ?? 0)) problems.push(`${file} passes process.env to ${count} launch(es) as is: wrap it in scrubbedEnv() from server/config.ts so saved keys and Wink's token stay out.`);
  }
  expect(problems).toEqual([]);
});

it("every process launch is listed, and every Claude pane gets the shared pane env", () => {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const file of ["server", "electron", "shared", "companion/src"].flatMap(shipped)) {
    const count = readFileSync(join(ROOT, file), "utf8").match(LAUNCH)?.length ?? 0;
    if (count) seen.set(file, count);
  }
  for (const [file, count] of seen) {
    const site = sites.get(file);
    if (!site) problems.push(`${file} starts a process but is not in SITES. If it can start Claude in a pane, ${FIX} and list it with claude:; otherwise list it with launches: ${count}.`);
    else if (site.launches !== count) problems.push(`${file} has ${count} process launches, SITES says ${site.launches}. If a new one can start Claude in a pane, ${FIX}; then update the count.`);
  }
  for (const [file, site] of sites) {
    if (!seen.has(file) && site.launches) problems.push(`${file} no longer starts a process; remove it from SITES.`);
    if (site.claude && !readFileSync(join(ROOT, file), "utf8").includes(site.claude)) problems.push(`${file} starts Claude panes but no longer shows "${site.claude}": ${FIX}.`);
  }
  expect(problems).toEqual([]);
});
