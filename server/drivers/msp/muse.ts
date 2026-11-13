// Meta Muse over MSP (`muse serve` stdio). Same driverKind as the ACP
// muse driver it replaces — stored configs key on the kind, so the fleet
// swap is one import change in drivers/builtIn.ts. WSL plumbing is shared
// with the ACP driver by import, never duplicated.
import { z } from "zod";

import type { ModelCatalog } from "../../contracts.ts";
import { toWslPath } from "../../env-path.ts";
import { isWslCommand } from "../../wsl-gate.ts";
import { createCliText } from "../cli-text.ts";
import {
  classifyMuseError,
  MuseAgentDriver,
  museAccount,
  museDefaultCli,
  museIsAuthenticated,
  museSignInCommand,
  museWslFallbackCli,
  resolveWslMuseCli,
  withWslKeySharing,
} from "../acp/muse.ts";
import { createMspDriver } from "./runtime.ts";

/** Live `model/list` on 1.2.1 advertises these four; the server default is
 * the contributor build. Kept static so boot never spawns for the catalog. */
export const MSP_MUSE_MODELS: ModelCatalog = {
  default: "muse-spark-1.3",
  options: [
    { id: "muse-spark-1.3", label: "Meta Muse 1.3" },
    { id: "muse-spark-1.3-contributor", label: "Meta Muse 1.3 Contributor" },
    { id: "muse-spark-1.2", label: "Meta Muse 1.2" },
    { id: "muse-spark-1.2-contributor", label: "Meta Muse 1.2 Contributor" },
  ],
};

/** Matches the CLI /effort picker exactly: minimal–max. none/ultra are
 * intentionally not offered — none duplicates unset (no other driver
 * offers it) and ultra behaves as max over the wire. */
export const MSP_MUSE_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const MUSE_TEXT_TIMEOUT_MS = 90_000;

const museTerminalSchema = z.object({
  payload_type: z.literal("run.terminal.completed"),
  payload: z.object({ terminal: z.string(), text: z.string().nullish() }),
});

function parseMuseText(stdout: string): string {
  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const terminal = museTerminalSchema.safeParse(record);
    if (terminal.success) text = terminal.data.payload.terminal === "completed" ? terminal.data.payload.text?.trim() ?? "" : "";
  }
  if (!text) throw new Error("Muse text returned no text");
  return text;
}

/** Muse's goal and verify judges re-read the chat after every turn. An unknown -c key refuses the run and `wsl` hands argv to a shell, so only native 1.4.15+ gets the switch. */
export function museServeArgs(version: string | null, wsl: boolean): string[] {
  const [major = 0, minor = 0, patch = 0] = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "")?.slice(1).map(Number) ?? [];
  const hasRoster = major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 15)));
  return hasRoster && !wsl ? ["-c", "run.reminder_roster.agents=[]"] : [];
}

export const MspMuseAgentDriver = createMspDriver({
  driverKind: "museAgent",
  displayName: "Meta Muse",
  models: MSP_MUSE_MODELS,
  effortLevels: MSP_MUSE_EFFORT_LEVELS,
  defaultCli: museDefaultCli(),
  nativeSource: "muse.msp",
  loginNote: `Muse CLI is not signed in — run \`${museSignInCommand()}\` in a terminal and complete the browser sign-in`,
  install: MuseAgentDriver.install,
  credentialEnv: ["META_API_KEY"],
  transformEnv: (env) => {
    if (process.platform === "win32") withWslKeySharing(env);
  },
  isAuthenticated: (env, config) => museIsAuthenticated(env, config),
  account: museAccount,
  requireAuthenticationBeforeSpawn: true,
  classifyError: classifyMuseError,
  wslProbeWrapper: museWslFallbackCli,
  wslResolveCli: resolveWslMuseCli,
  serveArgs: museServeArgs,
  text: ({ cli, env }) => createCliText({
    name: "Muse",
    model: MSP_MUSE_MODELS.default,
    timeoutMs: MUSE_TEXT_TIMEOUT_MS,
    command: async (promptFile) => {
      const command = await cli();
      return {
        cli: command,
        args: [
          "exec", "--json", "--prompt-file", isWslCommand(command) ? toWslPath(promptFile) : promptFile, "--no-session-log",
          "--model", MSP_MUSE_MODELS.default, "--reasoning-effort", "low", "--max-model-steps", "1",
          "--disable-web-tools", "--disable-shell", "--disable-write", "--disable-request-user-input",
          "--disable-reminders", "--no-foreign-personal-context", "--approval-judge", "off",
        ],
        env: env(),
      };
    },
    parse: parseMuseText,
  }),
});
