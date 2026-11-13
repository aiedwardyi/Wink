// Meta Muse over MSP (`muse serve` stdio). Same driverKind as the ACP
// muse driver it replaces — stored configs key on the kind, so the fleet
// swap is one import change in drivers/builtIn.ts. WSL plumbing is shared
// with the ACP driver by import, never duplicated.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import type { ModelCatalog } from "../../contracts.ts";
import { resolveCliSpawn, toWslPath } from "../../env-path.ts";
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

const MUSE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/;
const MUSE_URGENCY = ["none", "encouraged", "must_download"];

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
};

/** PowerShell's property lookup is case-insensitive. */
const jsonProp = (o: unknown, name: string): unknown => {
  if (!o || typeof o !== "object") return undefined;
  const key = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : (o as Record<string, unknown>)[key];
};
const jsonText = (o: unknown, name: string) => String(jsonProp(o, name) ?? "");

/** The launcher's Parse-ChannelManifest, reduced to the version it names. */
function releaseVersion(content: string, channel: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return null;
  }
  const version = jsonText(doc, "version");
  const url = jsonText(doc, "manifest_url");
  if (jsonText(doc, "channel") !== channel || !MUSE_VERSION.test(version)) return null;
  if (!url || /[\t\r\n\x1f]/.test(url) || !/^https:\/\//i.test(url)) return null;
  if (!MUSE_URGENCY.includes(jsonText(doc, "urgency")) || jsonProp(doc, "notification_text") == null) return null;
  return version;
}

/** Mirrors `.muse-launcher.ps1` for a host start: the active `muse-bin-<version>.exe`
 * and the env the launcher would hand it. Null whenever the launcher would do
 * anything but run that exe (update due, channel switch, missing binary), so it runs instead. */
export function museDirectHost(
  cli: string,
  env: Record<string, string | undefined>,
  now = Date.now(),
): { command: string; env: Record<string, string | undefined> } | null {
  if (process.platform !== "win32") return null;
  const launch = resolveCliSpawn(cli, []);
  const at = launch.args.indexOf("-File");
  const script = at === -1 ? undefined : launch.args[at + 1];
  if (!script || basename(script).toLowerCase() !== ".muse-launcher.ps1") return null;
  // Fixed args from the configured CLI ride after the script; the launcher keeps them.
  if (launch.args.length > at + 2) return null;
  if (env.MUSE_LAUNCHER_INSTALL === "1" || env.MUSE_INTERNAL_UPDATE === "1") return null;
  const dir = dirname(script);
  const channel = env.MUSE_CHANNEL?.trim() ? env.MUSE_CHANNEL : "muse-stable";
  if (channel !== "muse-stable" && channel !== "muse-canary") return null;
  if ((readText(join(dir, ".muse-channel"))?.trim() ?? "muse-stable") !== channel) return null;
  const version = readText(join(dir, ".muse-version"))?.trim();
  if (!version || !MUSE_VERSION.test(version)) return null;
  const exe = join(dir, `muse-bin-${version}.exe`);
  try {
    if (!statSync(exe).isFile()) return null;
  } catch {
    return null;
  }
  if (env.MUSE_NO_AUTO_UPDATE !== "1") {
    if (env.MUSE_SYNC_UPDATE === "1") return null;
    const interval = /^[0-9]+$/.test(env.MUSE_UPDATE_INTERVAL_SECONDS ?? "") ? Number(env.MUSE_UPDATE_INTERVAL_SECONDS) : 3600;
    const checked = readText(join(dir, ".muse-update-checked-at"))?.trim();
    if (!checked || !/^[0-9]+$/.test(checked) || Math.floor(now / 1000) - Number(checked) >= interval) return null;
  }
  // powershell.exe -ExecutionPolicy Bypass exports this to every child; shell tools inherit it.
  const out: Record<string, string | undefined> = { ...env, PSExecutionPolicyPreference: "Bypass" };
  const info = readText(join(dir, ".muse-release-info.json"));
  if (info !== null && releaseVersion(info, channel) === version) out.MUSE_RELEASE_INFO = info;
  else delete out.MUSE_RELEASE_INFO;
  return { command: exe, env: out };
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
  directHost: (cli, env) => museDirectHost(cli, env),
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
