// Antigravity driver — Google's `agy` CLI in headless one-shot print mode
// (`agy --print --output-format stream-json`), modeled on claude.ts but fully
// self-contained. Per-turn CLI process; the conversation continues across
// turns via `--conversation <id>` (the resumeCursor is agy's conversation_id)
// until Orbit compaction, when the harness starts a fresh conversation and
// injects the bounded transcript. Verified against agy 1.1.12 for event shapes.
// Prompt transport re-verified against agy 1.2.4: --input-format stream-json
// (since 1.1.15) carries the prompt on stdin as {"event":"user",...} NDJSON —
// not --print argv (mutually exclusive with stream-json input) and not Claude's
// {"type":"user"} shape.
//
// Unlike claude, print mode has NO interactive permission hook: there is no
// per-action broker here. `--mode accept-edits` allows file edits but
// auto-denies shell (`run_command` comes back as a tool ERROR); the default
// `request-review` auto-denies; `--dangerously-skip-permissions` (fullAuto)
// approves everything. Real per-action approval cards are a future path via
// native ACP, which would reuse acp/core.ts like grok/gemini.
//
// MCP: agy has no per-turn MCP flag, so Wink's servers (agents, terminal, and
// the bot's computer: cloud box / Local VM / VPS) are mounted into the global
// `~/.gemini/config/mcp_config.json` around each child - see
// ensureAntigravityComputerMcp below. Computer use is full-auto instances
// only; the host desktop stays off (no approval channel in print mode, ever).
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

import { applyCredentialAllowlist, DATA_DIR } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { augmentedPath } from "../env-path.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { injectedApiModel, mergeLocalInject } from "./local-inject.ts";
import { experimentalAgents, originalCatalogCall } from "./tool-catalog.ts";

import type { ChildProcess } from "node:child_process";
import type {
  DriverCreateInput,
  ModelCatalog,
  PrepareFocus,
  PrepareTurn,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { cliNotFound, newEventId, newId } from "../contracts.ts";
import { appendNative, finishNative } from "./native.ts";
import { AGY_TEXT_MODEL, textUsageError } from "./rate-limits.ts";
import { BUSY_RESUME_DELAYS_MS, busyResumeReason, interruptibleDelay, isResumeCursorRejected } from "./retry.ts";
import { systemLedger } from "./system-ledger.ts";
import { ANTIGRAVITY_KEYRING, antigravityKeyringSignOut, antigravitySignIn, forgetAntigravitySignIn, hasAntigravityTokenFile, probeAntigravitySignIn, readAntigravityAccount, readAntigravityLogSignIn, signedOutMarkFile } from "./antigravity-auth.ts";
import { antigravityHelperHome } from "./antigravity-home.ts";
import { unrestated } from "../turn-reply.ts";
import { FREE_ACCESS, type TurnAccess } from "./turn-access.ts";
import { warmPool, type Lease } from "./warm-pool.ts";

const DRIVER_KIND = "antigravityAgent";
const AGY_STOPPED_NOTE = "The bot stopped before finishing.";
const AGY_BUSY_RESUME_PROMPT = "continue";
const AGY_STILL_BUSY = "Gemini is still busy after 3 tries. Try another model.";
const AGY_SYSTEM_NOTICE = /(?:The following is a )?<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>\s*/gi;
const AGY_CONTEXT_CANCELLATION = /\bcontext\s+cancel(?:ed|led)\b/i;
const AGY_ACCOUNT_ERROR =
  /unauthorized|unauthenticated|\bforbidden\b|(?<![\w-])40[13](?![\w-])|not logged in|\bsign[\s-]?in\b|authentication failed|permission_denied|permission denied|has not been used in project|\bapi\b[^.\n]{0,120}\bdisabled\b/i;
const AGY_NOT_ACCOUNT_ERROR = /\brate[\s-]?limit\b|(?<![\w-])429(?![\w-])|\berror-code-(?:429|5\d\d)\b|\btoo many requests\b|resource[ _]exhausted|quota exceeded|exceeded[^.\n]{0,40}\bquota\b|(?<![\w-])5\d\d(?![\w-])|\b5xx\b/i;
const AGY_TIMEOUT_ERROR = /\b(?:watchdog timeout|timed out|time-out|timeout)\b/i;
// agy keeps one conversation store for every account and backend (a Vertex
// project, a consumer sign-in), but the API only takes back the thought
// signatures it minted itself. After a sign-in change, every model refuses
// the older conversation's history with a 400 and never will take it.
const AGY_SIGNATURES_REFUSED = /\bthought[_ ]signature\b/i;
const AGY_MODEL_DENIED = /\bpermission\b[^\n]{0,80}\bdenied\b[^\n]{0,200}\bmodels\/|\bmodels\/[^\n]{0,200}\b(?:permission[_ ]denied|not[_ ]found|(?:may|does) not exist)\b/i;

/** Account or permission failure. Rate limits, 5xx, and timeout-only lines are not. */
export function isAgyAccountError(text: string): boolean {
  if (AGY_NOT_ACCOUNT_ERROR.test(text)) return false;
  if (AGY_TIMEOUT_ERROR.test(text) && !AGY_ACCOUNT_ERROR.test(text)) return false;
  return AGY_ACCOUNT_ERROR.test(text);
}

function stripAntigravitySystemNotices(text: string): string {
  return text.replace(AGY_SYSTEM_NOTICE, "");
}

const AGY_NOTICE_HEADS = ["the following is a <system_message>", "<system_message>"];

/** Where a notice that has not fully streamed in yet begins (text.length if none). */
function unfinishedNoticeStart(text: string): number {
  const open = text.search(/(?:The following is a )?<SYSTEM_MESSAGE>/i);
  if (open !== -1) return open;
  const lower = text.toLowerCase();
  for (let i = Math.max(0, lower.length - AGY_NOTICE_HEADS[0].length); i < lower.length; i++) {
    if (AGY_NOTICE_HEADS.some((head) => head.startsWith(lower.slice(i)))) return i;
  }
  return text.length;
}

function isCancelledTool(payload: { state?: string; tool_info?: { output?: string } | string }): boolean {
  return payload.state === "ERROR" && AGY_CONTEXT_CANCELLATION.test(JSON.stringify(payload.tool_info ?? payload));
}

export interface AntigravityConfig {
  cli: string;
  fullAuto: boolean;
}

// model catalog from `agy models` (agy 1.3.5)
export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.1-pro-high",
  options: [
    // Carbon ids confirmed against `agy models` on agy 1.5.8
    { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)", contextWindow: 1_048_576 },
    { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-4-carbon-low", label: "Gemini 4 Carbon (Low)", contextWindow: 1_048_576 },
    // Neon ids confirmed against `agy models` on agy 1.5.11
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", contextWindow: 1_048_576 },
    { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)", contextWindow: 1_048_576 },
    { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)", contextWindow: 1_048_576 },
    // Hydrogen ids confirmed against `agy models` on agy 1.5.5
    { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)", contextWindow: 1_048_576 },
    { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)", contextWindow: 1_048_576 },
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", contextWindow: 1_048_576 },
    { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)", contextWindow: 1_048_576 },
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)", contextWindow: 1_048_576 },
    { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)", contextWindow: 1_048_576 },
    // 3.8 ids confirmed against the agy 1.1.26 binary's own model table;
    // there is no bare gemini-3.8-flash, only the three throttle tiers
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", contextWindow: 1_048_576 },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", contextWindow: 1_048_576 },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", contextWindow: 1_048_576 },
    // claude-sonnet-4-6, claude-opus-4-6-thinking, and gpt-oss-120b-medium
    // below predate the ground-truth rule and do not appear
    // in a current `agy models` run — see MODEL-AG-STALE. Left in place
    // pending a follow-up to confirm or remove them; see
    // ANTIGRAVITY_UNVERIFIED_LEGACY_IDS in antigravity.test.ts.
    // gpt-oss 128k is the published figure, not confirmed against agy.
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", contextWindow: 1_000_000 },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", contextWindow: 1_000_000 },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", contextWindow: 131_072 },
  ],
};

function antigravityEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), ...overrides };
  // Antigravity uses its own login, so it is granted no credential at all —
  // not the workspace secrets the desktop shell injects, not another
  // provider's key, in any of its turn, snapshot, or helper children.
  applyCredentialAllowlist(env);
  // agy's detached --bg-updater (15+ min after its last check) opens a visible console on Windows.
  if (process.platform === "win32") env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return env;
}

const AGY_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return AGY_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; name?: unknown; displayName?: unknown };
    const id = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : "";
    if (!AGY_MODEL_ID.test(id)) return [];
    const label = typeof row.name === "string" ? row.name : typeof row.displayName === "string" ? row.displayName : id;
    return [{ id, label }];
  });
}

/** Extra ids from ~/.gemini/antigravity-cli/settings.json, if the user added any. */
export function readAntigravityModelCatalog(env: Record<string, string | undefined> = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(
      readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return STATIC_ANTIGRAVITY_MODELS;
  }
  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  if (typeof settings.model === "string") extras.push(...extrasFromUnknown([settings.model]));
  const options = STATIC_ANTIGRAVITY_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_ANTIGRAVITY_MODELS.default, options };
}

// ── computer MCP mount ──────────────────────────────────────────────────
// agy has no per-session MCP flag and no project-level MCP config: verified
// against agy 1.1.19, whose embedded docs list exactly two locations — the
// global `~/.gemini/config/mcp_config.json` and per-plugin files — and whose
// `agy mcp list` ignores `.gemini/{settings,mcp_config}.json` in the cwd.
// So Wink's servers are mounted into the global file for each child's
// lifetime: every other byte of the user's config is preserved, and a
// malformed file starts from a fresh object instead of failing the turn (the
// ensureOpenCodeInjectModel discipline). The agents and terminal entries are
// static: each MCP child inherits its agy process's env (verified agy
// 1.2.16), so a turn's identity rides there, never in the shared file.
export const ANTIGRAVITY_COMPUTER_MCP_KEY = "openmausbot-computer";
export const ANTIGRAVITY_AGENTS_MCP_KEY = "openmausbot-agents";
export const ANTIGRAVITY_TERMINAL_MCP_KEY = "openmausbot-terminal";

type TurnUsage = { input: number; output: number; cachedInput?: number };

export interface AntigravityComputerMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// agy's MCP file is machine-global. Computer-less turns share it; a computer
// turn's entry carries its box token, so that turn holds the file alone.
// FIFO with writer preference: once a computer turn waits, later turns queue
// behind it.
let mcpSharedHolders = 0;
let mcpExclusiveHeld = false;
const mcpWaiters: Array<{ exclusive: boolean; grant: () => void }> = [];
const mcpExclusiveWanted = () => mcpExclusiveHeld || mcpWaiters.some((waiter) => waiter.exclusive);

function pumpAntigravityMcpLock() {
  while (mcpWaiters.length && !mcpExclusiveHeld && !(mcpWaiters[0].exclusive && mcpSharedHolders > 0)) {
    const waiter = mcpWaiters.shift()!;
    if (waiter.exclusive) mcpExclusiveHeld = true;
    else mcpSharedHolders += 1;
    waiter.grant();
  }
}

/** Resolves with the release once granted; cancel() drops a waiter that was never granted. */
function acquireAntigravityMcpLock(exclusive: boolean) {
  // a standby holds the shared mount until it exits
  if (exclusive) warmPool.invalidate({ engine: DRIVER_KIND }, "computer turn");
  let cancel = () => {};
  const granted = new Promise<() => void>((resolve) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (exclusive) mcpExclusiveHeld = false;
      else mcpSharedHolders -= 1;
      pumpAntigravityMcpLock();
    };
    const waiter = {
      exclusive,
      grant: () => resolve(release),
    };
    cancel = () => {
      const index = mcpWaiters.indexOf(waiter);
      if (index === -1) return;
      mcpWaiters.splice(index, 1);
      resolve(() => {});
      pumpAntigravityMcpLock();
    };
    mcpWaiters.push(waiter);
    pumpAntigravityMcpLock();
  });
  return { granted, cancel };
}

// One mount per config file for all computer-less holders: the first mounts,
// the last restores.
const sharedMcpMounts = new Map<string, { holders: number; restore: () => void }>();

/** Mount for one child under the lock; a computer turn's mount is its own. */
function mountAntigravityMcp(
  computer: AntigravityComputerMcpServer | null,
  env: Record<string, string | undefined>,
): () => void {
  if (computer) return ensureAntigravityComputerMcp(computer, env);
  const path = antigravityMcpConfigPath(env);
  const mount = sharedMcpMounts.get(path) ?? { holders: 0, restore: ensureAntigravityComputerMcp(null, env) };
  mount.holders += 1;
  sharedMcpMounts.set(path, mount);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mount.holders -= 1;
    if (mount.holders > 0) return;
    sharedMcpMounts.delete(path);
    mount.restore();
  };
}

function antigravityMcpConfigPath(env: Record<string, string | undefined>): string {
  return join(env.HOME || env.USERPROFILE || homedir(), ".gemini", "config", "mcp_config.json");
}

function withoutWinkMcpServers(servers: z.infer<typeof mcpConfigFileSchema>["mcpServers"] = {}, owned: Iterable<string>) {
  const keys = new Set(owned);
  return Object.fromEntries(Object.entries(servers).filter(([key]) => !keys.has(key)));
}

// Per config file, the keys Wink mounted and has not yet restored. Only these are Wink's: a user's own
// openmausbot-* server is theirs, and a crash leaves the record for the next run to clean.
const OWNED_MCP_RECORD = join(DATA_DIR, "gemini-mcp-owned.json");
const ownedMcpRecordSchema = z.record(z.string(), z.array(z.string()));

function readOwnedMcpRecord(): z.infer<typeof ownedMcpRecordSchema> {
  try {
    return ownedMcpRecordSchema.parse(JSON.parse(readFileSync(OWNED_MCP_RECORD, "utf8")));
  } catch {
    return {};
  }
}

function ownedMcpKeys(path: string): string[] {
  return readOwnedMcpRecord()[path] ?? [];
}

function recordOwnedMcpKeys(path: string, keys: string[]): void {
  const record = readOwnedMcpRecord();
  if (keys.length) record[path] = keys;
  else if (path in record) delete record[path];
  else return;
  mkdirSync(dirname(OWNED_MCP_RECORD), { recursive: true });
  writeFileSync(OWNED_MCP_RECORD, JSON.stringify(record));
}

/** agy's MCP config without Wink's keys: a standby started on other servers is not this turn's launch. */
function userMcpConfig(env: Record<string, string | undefined>): string {
  const path = antigravityMcpConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  try {
    const config = mcpConfigFileSchema.parse(JSON.parse(text));
    return JSON.stringify({ ...config, mcpServers: withoutWinkMcpServers(config.mcpServers, ownedMcpKeys(path)) });
  } catch {
    return text;
  }
}

function winkProxyMcpServer(proxy: string): AntigravityComputerMcpServer {
  return { command: process.execPath, args: [proxy], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

// Lenient by design: keep every unknown key the user put in the file. A
// present-but-wrong mcpServers (e.g. an array) fails the parse and is
// rebuilt fresh — that file was already unusable to agy itself.
const mcpConfigFileSchema = z.looseObject({
  mcpServers: z.looseObject({}).optional(),
});

/** The computer MCP server for this turn, or null when the turn has none.
 * Cloud boxes go through OpenMausBot's REST-to-MCP adapter (the same spec
 * claude.ts and codex.ts build); Local VM and VPS connections arrive as a
 * ready-made Cua Driver stdio command and pass through unchanged. */
export function antigravityComputerMcpServer(
  integrations: SendTurnInput["integrations"],
): AntigravityComputerMcpServer | null {
  const computer = integrations?.computer;
  if (computer) {
    const proxyEnv = computerProxyEnv(computer);
    return {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: proxyEnv.OGB_BOX_ID ?? "",
        OGB_BOX_TOKEN: proxyEnv.OGB_BOX_TOKEN ?? "",
        // who-is-driving endpoint, so a person taking the wheel in the
        // panel pauses this bot's hands mid-turn
        OMB_CONTROL_URL: proxyEnv.OMB_CONTROL_URL ?? "",
        OMB_CONTROL_TOKEN: proxyEnv.OMB_CONTROL_TOKEN ?? "",
      },
    };
  }
  const local = integrations?.localComputer;
  if (local) return { command: local.command, args: local.args, env: { ...local.env } };
  return null;
}

const sweptMcpConfigs = new Set<string>();

/** Once per run, before any mount: drops the keys a crash or kill left in agy's config (a standby keeps them there while it idles). */
function sweepAntigravityMcpLeftover(env: Record<string, string | undefined>): void {
  const path = antigravityMcpConfigPath(env);
  if (sweptMcpConfigs.has(path) || sharedMcpMounts.has(path) || mcpExclusiveHeld) return;
  sweptMcpConfigs.add(path);
  const owned = new Set(ownedMcpKeys(path));
  if (!owned.size) return;
  let config: z.infer<typeof mcpConfigFileSchema>;
  try {
    config = mcpConfigFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return;
  }
  if (Object.keys(config.mcpServers ?? {}).some((key) => owned.has(key))) {
    writeFileSync(path, `${JSON.stringify({ ...config, mcpServers: withoutWinkMcpServers(config.mcpServers, owned) }, null, 2)}\n`, { mode: 0o600 });
  }
  recordOwnedMcpKeys(path, []);
}

/** Mount Wink's static agents and terminal entries, plus the computer entry
 * when given, into the global mcp_config.json. A key a crash left, or one Wink
 * writes over, is Wink's: left out of the restore. */
export function ensureAntigravityComputerMcp(
  server: AntigravityComputerMcpServer | null,
  env: Record<string, string | undefined> = process.env,
): () => void {
  const path = antigravityMcpConfigPath(env);
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : null;
  let config: z.infer<typeof mcpConfigFileSchema> = {};
  try {
    const parsed = mcpConfigFileSchema.safeParse(JSON.parse(original ?? ""));
    if (parsed.success) config = parsed.data;
  } catch {
    // Missing or malformed user config — rebuild only what the mount needs.
  }
  const keys = [ANTIGRAVITY_AGENTS_MCP_KEY, ANTIGRAVITY_TERMINAL_MCP_KEY, ...(server ? [ANTIGRAVITY_COMPUTER_MCP_KEY] : [])];
  const owned = new Set([...ownedMcpKeys(path), ...keys]);
  const userServers = withoutWinkMcpServers(config.mcpServers, owned);
  const servers = {
    ...userServers,
    [ANTIGRAVITY_AGENTS_MCP_KEY]: winkProxyMcpServer(SPAWNED_PROXIES.agents),
    [ANTIGRAVITY_TERMINAL_MCP_KEY]: winkProxyMcpServer(SPAWNED_PROXIES.terminal),
    ...(server ? { [ANTIGRAVITY_COMPUTER_MCP_KEY]: { command: server.command, args: server.args, env: server.env } } : {}),
  };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existed) chmodSync(path, 0o600);
  const mounted = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
  recordOwnedMcpKeys(path, keys);
  writeFileSync(path, mounted, { mode: 0o600 });
  chmodSync(path, 0o600);

  const hadLeftover = Object.keys(config.mcpServers ?? {}).some((key) => owned.has(key));
  const restoreTo =
    original !== null && hadLeftover ? `${JSON.stringify({ ...config, mcpServers: userServers }, null, 2)}\n` : original;

  // Restore what was present before the mount when nobody else touched the
  // file. A user's own agy process is outside our module-wide lock, so if it
  // edited the config concurrently, preserve that edit and drop only Wink's
  // keys instead of replacing (or deleting) the whole file.
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return recordOwnedMcpKeys(path, []);
      throw error;
    }
    if (current === mounted) {
      if (restoreTo === null) unlinkSync(path);
      else {
        writeFileSync(path, restoreTo, { mode: 0o600 });
        chmodSync(path, 0o600);
      }
      recordOwnedMcpKeys(path, []);
      return;
    }

    // A malformed concurrent edit is not safe to rewrite. Leaving a stale
    // OpenMausBot entry is preferable to destroying bytes we cannot interpret.
    let currentJson: unknown;
    try {
      currentJson = JSON.parse(current);
    } catch {
      return;
    }
    const parsed = mcpConfigFileSchema.safeParse(currentJson);
    if (!parsed.success) return;
    const currentConfig = parsed.data;
    writeFileSync(
      path,
      `${JSON.stringify({ ...currentConfig, mcpServers: withoutWinkMcpServers(currentConfig.mcpServers, owned) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    recordOwnedMcpKeys(path, []);
  };
}

function decodeConfig(raw: unknown): AntigravityConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.cli !== undefined && typeof o.cli !== "string") {
    throw new Error(`antigravity: invalid cli ${JSON.stringify(o.cli)}`);
  }
  if (o.fullAuto !== undefined && typeof o.fullAuto !== "boolean") {
    throw new Error(`antigravity: invalid fullAuto ${JSON.stringify(o.fullAuto)}`);
  }
  return {
    cli: typeof o.cli === "string" ? o.cli : "agy",
    // Default fullAuto to TRUE: agy's headless print harness invokes tools even
    // for trivial prompts and, with no interactive approval channel, auto-denies
    // them — producing no output, so a non-fullAuto bot's turns frequently fail.
    // Default to fullAuto for a usable bot; per-action consent returns with the
    // ACP v2 path. Still throws above on a non-boolean fullAuto.
    fullAuto: o.fullAuto === undefined ? true : o.fullAuto === true,
  };
}


/** Windows CreateProcess lpCommandLine ceiling (characters), including the exe path. */
export const WIN32_CREATEPROCESS_CMDLINE_MAX = 32_767;

/** Compose persona/system + user text the same way --print argv used to. Continuity
 * injected by the harness into system/text is preserved verbatim — never stripped. */
export function composeAntigravityPrompt(system: string | null | undefined, text: string): string {
  return system ? `${system}\n\n${text}` : text;
}

/** One NDJSON stdin line for `--input-format stream-json` (agy 1.1.15+). The CLI
 * requires an `event` key — Claude's `type` key is rejected. */
export function antigravityStreamUserLine(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;
}

/** Quote one argv token the way Node approximates CreateProcess on win32. */
export function quoteWin32ArgvToken(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Estimated CreateProcess command-line length for command + args on Windows. */
export function estimateWin32CmdlineLength(command: string, args: string[]): number {
  return [command, ...args].map(quoteWin32ArgvToken).join(" ").length;
}

/** Print mode never asks: skip-permissions runs everything, accept-edits denies run_command, the default denies both. */
export function antigravityAccess(argv: readonly string[]): TurnAccess {
  if (argv.includes("--mode") && argv[argv.indexOf("--mode") + 1] === "plan") return { edits: "off", commands: "off" };
  if (argv.includes("--dangerously-skip-permissions")) return FREE_ACCESS;
  return { edits: argv.includes("accept-edits") ? "free" : "off", commands: "off" };
}

export interface AntigravityTurnArgvInput {
  fullAuto: boolean;
  cwd: string;
  model?: string | null;
  resumeCursor?: string | null;
  readOnly?: boolean;
}

/** Print-mode argv with the prompt on stdin — never on --print. */
export function buildAntigravityTurnArgv(input: AntigravityTurnArgvInput): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "60m",
    "--add-dir",
    input.cwd,
  ];
  // plan, never agy's default mode: the user's own agy settings can make the default edit and run commands
  // plan reads outside the workspace only with Non-Workspace Access, which the owner may have turned on for themselves
  if (input.readOnly) args.push("--mode", "plan", "--settings", JSON.stringify({ allowNonWorkspaceAccess: false }));
  else if (input.fullAuto) args.push("--dangerously-skip-permissions");
  else {
    args.push("--mode", "accept-edits");
  }
  if (input.model) args.push("--model", injectedApiModel(input.model) ?? input.model);
  if (input.resumeCursor) args.push("--conversation", input.resumeCursor);
  return args;
}

/** Length-only accounting for spawn budgets. Never logs private text or credentials. */
export function measureAntigravityTransportLengths(opts: {
  userText: string;
  system?: string | null;
  continuity?: string | null;
  toolMcpConfigJson?: string | null;
  cli: string;
  argv: string[];
  stdinLine: string;
}): {
  userTextChars: number;
  systemChars: number;
  continuityChars: number;
  toolMcpConfigChars: number;
  totalArgvChars: number;
  stdinBytes: number;
  promptBytes: number;
} {
  const prompt = composeAntigravityPrompt(opts.system, opts.userText);
  return {
    userTextChars: opts.userText.length,
    systemChars: (opts.system ?? "").length,
    continuityChars: (opts.continuity ?? "").length,
    toolMcpConfigChars: (opts.toolMcpConfigJson ?? "").length,
    totalArgvChars: estimateWin32CmdlineLength(opts.cli, opts.argv),
    stdinBytes: Buffer.byteLength(opts.stdinLine),
    promptBytes: Buffer.byteLength(prompt),
  };
}

/** A one-shot agy started on the thread's conversation once a turn's child exits, or for a new chat when it opens: it signs in,
 * starts its MCP servers and loads the conversation while the user reads, then serves exactly one turn the way a cold spawn would. */
type Standby = {
  child: ReturnType<typeof spawnCli>;
  /** stdout lines (only init) and stderr from before the turn took it */
  lines: string[];
  partial: string;
  stderr: string;
  closed: boolean;
  broken: boolean;
  exited: Promise<void>;
  restoreMcp: () => void;
  releaseMcpLock: () => void;
  detach: () => void;
  lease: Lease;
  /** agy's account as its logs named it at launch */
  account: string | undefined;
};

/** Idle standbys of every instance, each resolving when its process exits. */
const standbyExits = new Set<Promise<void>>();

/** agy's sign-in is one per machine: retires every idle Gemini standby and waits for their exits (5 s at most). */
async function retireStandbys(reason: string): Promise<void> {
  warmPool.invalidate({ engine: DRIVER_KIND }, reason);
  if (!standbyExits.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([...standbyExits]), new Promise<void>((done) => { timer = setTimeout(done, 5_000); })]);
  clearTimeout(timer);
}

/** Everything fixed at spawn; a turn runs on a standby only when its own launch hashes the same. */
function launchFingerprint(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, turn: SendTurnInput): string {
  return createHash("sha256")
    .update(JSON.stringify([cli, args, cwd, Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)), turn.model ?? "", turn.effort ?? "", turn.approval ?? "", userMcpConfig(env)]))
    .digest("hex");
}

// agy's saved sign-in is one per machine, so every instance shares one keyring sign-out and its running turns.
const keyringSignOut = antigravityKeyringSignOut(async () => {
  await retireStandbys("sign-out");
  return forgetAntigravitySignIn(ANTIGRAVITY_KEYRING);
}, {
  present: () => probeAntigravitySignIn(),
  mark: signedOutMarkFile(join(DATA_DIR, "gemini-signed-out")),
});

export const AntigravityDriver: ProviderDriver<AntigravityConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Gemini (Antigravity)", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      win32: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    docsUrl: "https://github.com/google-antigravity/antigravity-cli#installation",
    signInCommand: "agy",
    // agy has no login or logout subcommand: a helper runs them over agy's ACP server (see loginConfig).
    // agy opens no browser over SSH, so a phone gets the link and paste prompt.
    login: { args: ["login"], deviceArgs: ["login", "--paste"], deviceEnv: { SSH_CONNECTION: "127.0.0.1 50000 127.0.0.1 22" }, authHosts: ["accounts.google.com"] },
    logout: ["logout"],
  },
  models: STATIC_ANTIGRAVITY_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AntigravityConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    // Per call, so agy installed after Wink started is on PATH without a restart.
    const env = () => antigravityEnvironment(input.environment);
    sweepAntigravityMcpLeftover(env());
    const signIn = antigravitySignIn(async () => hasAntigravityTokenFile(env()) || probeAntigravitySignIn(), () => readAntigravityLogSignIn(env()));
    const forgetSignedOut = keyringSignOut.onSignedOut(() => {
      signIn.record(false);
      void retireStandbys("signed out");
    });
    keyringSignOut.attach();
    let models = STATIC_ANTIGRAVITY_MODELS;
    const refreshModels = async () => {
      try {
        const catalogEnv: Record<string, string | undefined> = env();
        const resolved = await mergeLocalInject(readAntigravityModelCatalog(catalogEnv), catalogEnv);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; interrupt: () => void; turnId: string }>();
    let disposed = false;
    const systemHeld = systemLedger(true, instanceId);
    // every live agy child, tracked independently of `active`: a child can
    // hang AFTER emitting `result` (so it's already removed from `active`), and
    // dispose()/stopAll() must still be able to reap it. Removed on process exit.
    const children = new Set<ChildProcess>();

    const emit = (event: RuntimeEvent) => {
      if (event.type === "turn.completed" && event.ok) signIn.record(true);
      else if (event.type === "runtime.error" && event.signIn) signIn.record(false);
      if (event.type === "turn.started") keyringSignOut.turnStarted(`${instanceId}\0${event.turnId}`);
      else if (event.type === "turn.completed") keyringSignOut.turnEnded(`${instanceId}\0${event.turnId}`);
      finishNative(event);
      for (const l of [...listeners]) l(event);
    };

    // Reap every tracked child's tree (mirrors the per-turn stop()) — POSIX
    // process group on mac/linux, taskkill /T on Windows. When escalate is
    // set a SIGKILL follows after a grace for anything that ignored the term;
    // on Windows killCliTree is already a force kill, so the retry is a no-op.
    const reapChildren = (escalate: boolean) => {
      for (const child of children) {
        killCliTree(child);
        if (escalate && process.platform !== "win32") {
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {}
          }, 2000).unref?.();
        }
      }
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const incarnation = input.incarnation ?? newId();
    const warmKey = (threadId: string) => ({ engine: DRIVER_KIND, instanceId, threadId });
    const captured = (threadId: string) => ({ generation: warmPool.generation(warmKey(threadId)), incarnation, identity: "" });
    const standbys = new WeakMap<Lease, Standby>();
    const standbyOf = new Map<string, Standby>();

    /** The folder and env a turn's agy runs with; a standby launched otherwise never serves it. */
    const launchOf = (turn: SendTurnInput) => {
      // Default cwd to a per-thread workspace under DATA_DIR — deliberately
      // NOT homedir(): a bot running unattended should not get the whole home
      // as its default sandbox. `--add-dir` grants agy access to that dir.
      // strip filesystem-unsafe chars only — never truncate: a 36-char UUID
      // sliced to 32 would collide two threads sharing the first 32 chars onto
      // one workspace dir. replace() already keeps a UUID unique and safe.
      const tag = turn.threadId.replace(/[^\w-]/g, "");
      const workspace = join(DATA_DIR, "workspaces", tag);
      mkdirSync(workspace, { recursive: true });
      // The static agents and terminal entries read this turn's identity from
      // agy's env. Added after the credential allowlist, which strips *_TOKEN;
      // the node flag would leak into every shell command the agent runs.
      const { ELECTRON_RUN_AS_NODE: _nodeFlag, ...identity } = {
        ...turn.integrations?.terminal?.env,
        ...(turn.integrations?.agents && experimentalAgents(turn.integrations.agents, true).env),
      };
      return { cwd: turn.cwd ?? workspace, childEnv: { ...env(), ...identity } };
    };

    /** Takes over the exiting turn's shared mount and lock, so agy's config is not rewritten between the two. */
    const startStandby = (
      threadId: string,
      conversation: string | null,
      turn: SendTurnInput,
      cwd: string,
      childEnv: NodeJS.ProcessEnv,
      mcp: { restoreMcp: () => void; releaseMcpLock: () => void },
    ) => {
      let held = true;
      const finalizeMcp = () => {
        if (!held) return;
        held = false;
        try {
          mcp.restoreMcp();
        } catch (error) {
          console.warn("[antigravity] could not restore Antigravity's MCP config", error);
        } finally {
          mcp.releaseMcpLock();
        }
      };
      // a standby started beside a running turn would load the conversation before that turn's messages
      if (disposed || active.has(threadId) || keyringSignOut.pending || mcpExclusiveWanted()) return finalizeMcp();
      const args = buildAntigravityTurnArgv({ fullAuto: config.fullAuto, cwd, model: turn.model, resumeCursor: conversation, readOnly: turn.readOnly });
      const lease = warmPool.reserve(warmKey(threadId), launchFingerprint(config.cli, args, cwd, childEnv, turn), captured(threadId), "speculative");
      if (typeof lease !== "object" || standbys.has(lease)) return finalizeMcp();
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        finalizeMcp();
        lease.release("spawn failed");
        return;
      }
      children.add(child);
      let exited!: () => void;
      const standby: Standby = {
        child, lines: [], partial: "", stderr: "", closed: false, broken: false,
        exited: new Promise((done) => { exited = done; }),
        restoreMcp: mcp.restoreMcp, releaseMcpLock: mcp.releaseMcpLock, detach: () => {}, lease, account: readAntigravityAccount(env()),
      };
      const unusable = (reason: string) => {
        standby.broken = true;
        lease.release(reason);
      };
      const onData = (chunk: string) => {
        standby.partial += chunk;
        let nl;
        while ((nl = standby.partial.indexOf("\n")) !== -1) {
          const line = standby.partial.slice(0, nl);
          standby.partial = standby.partial.slice(nl + 1);
          if (!line.trim()) continue;
          standby.lines.push(line);
          let event: unknown;
          try {
            event = JSON.parse(line).event;
          } catch {}
          // agy prints only init before its first prompt
          if (event !== "init") unusable("output before prompt");
        }
      };
      const onStderr = (chunk: string) => {
        standby.stderr = (standby.stderr + chunk).slice(-8192);
      };
      const onError = () => unusable("spawn error");
      const onClose = () => {
        finalizeMcp();
        lease.release("exit");
      };
      child.once("close", () => {
        standby.closed = true;
        children.delete(child);
        standbyExits.delete(standby.exited);
        if (standbyOf.get(threadId) === standby) standbyOf.delete(threadId);
        exited();
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.stderr.on("data", onStderr);
      child.on("error", onError);
      child.on("close", onClose);
      standby.detach = () => {
        child.stdout.off("data", onData);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("close", onClose);
        standbyExits.delete(standby.exited);
      };
      standbyExits.add(standby.exited);
      standbys.set(lease, standby);
      standbyOf.set(threadId, standby);
      lease.attach({
        session: conversation ? { kind: "loaded", id: conversation } : { kind: "fresh" },
        alive: () => !standby.closed && !standby.broken,
        close: async () => {
          if (!standby.closed) killCliTree(child);
          await standby.exited;
        },
      });
      lease.ready();
    };

    /** The thread's standby when this launch matches it; otherwise a dying one to wait out, so two agy never share a conversation. */
    const takeStandby = (threadId: string, fingerprint: string, resumeCursor: string | null): { standby?: Standby; dying?: Promise<void> } => {
      const taken = warmPool.take(warmKey(threadId), fingerprint, captured(threadId), resumeCursor);
      if (typeof taken === "object") {
        const standby = "hit" in taken ? standbys.get(taken.hit) : undefined;
        if (standby && !standby.closed && !standby.broken) {
          standby.detach();
          return { standby };
        }
        ("hit" in taken ? taken.hit : taken.pending).release("unusable");
      }
      const dying = standbyOf.get(threadId);
      if (!dying || dying.closed) return {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      return { dying: Promise.race([dying.exited, new Promise<void>((done) => { timer = setTimeout(done, 2_000); })]).finally(() => clearTimeout(timer)) };
    };

    // A resume fallback relaunch is the same logical turn: the harness holds
    // the first id as live and drops events from any other.
    const sendTurn = async (turn: SendTurnInput, relaunchOf?: string, busyResumes = 0, priorUsage: TurnUsage = { input: 0, output: 0 }, shownResponses = new Set<string>()) => {
      const { threadId } = turn;
      const pendingSignOut = !relaunchOf && keyringSignOut.pending;
      const signedOut = pendingSignOut && await pendingSignOut;
      if (disposed) throw new Error("Antigravity instance is disposed");
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = relaunchOf ?? newId();
      const epoch = warmPool.generation(warmKey(threadId));
      if (signedOut) {
        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "runtime.error", message: "Gemini is not signed in.", setup: true, signIn: true, signedOut: true });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "signed_out", cost: null });
        return { turnId };
      }

      const { cwd, childEnv } = launchOf(turn);

      // Prompt travels on stdin via --input-format stream-json (agy 1.1.15+;
      // verified 1.2.4). --print <prompt> is mutually exclusive with that
      // transport and is what blew Windows CreateProcess (~32k) with long
      // pastes / injected continuity. Continuity stays in system/text.
      const resumeCursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const system = systemHeld.prompt(resumeCursor, turn.system);
      if (system && resumeCursor) systemHeld.forget(resumeCursor);
      else if (resumeCursor) systemHeld.begin(resumeCursor);
      const prompt = composeAntigravityPrompt(system, turn.text);

      let settled = false;
      // the model answered this prompt, so the session holds it
      let promptAccepted = false;
      // conversation_id from the init event → the resumeCursor (session.started
      // is what the harness persists as the cursor). Also seeds tool item ids.
      let conversationId: string | null = null;
      // agy's checkpoint step summarizes the conversation; a later turn can drop
      // everything before it, so the next prompt re-sends the system text
      let checkpointed = false;
      // backstop watchdog: if agy hangs without emitting `result` and without
      // exiting, the bot would stay busy forever (agy's own --print-timeout 60m
      // is the only other net). Assigned just below; settle() always clears it.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // Assigned once the child exists. A child can emit `result` and then
      // hang, so settling must still arrange for process and MCP cleanup.
      let armPostSettleCleanup = () => {};
      // A conversation agy cannot continue: the same logical turn starts a new
      // one seeded with the harness's transcript fallback.
      const relaunchFresh = (abandoned: string | null) => {
        settled = true;
        clearTimeout(watchdog);
        if (abandoned) systemHeld.forget(abandoned);
        armPostSettleCleanup();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.retrying", attempt: 1, delayMs: 0, reason: "resume_cursor" });
        void sendTurn({
          ...turn,
          text: turn.resumeFallback!.text,
          resumeCursor: undefined,
          resumeFallback: undefined,
        }, turnId).catch((error) => {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: error instanceof Error ? error.message : String(error),
          });
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: "resume_fallback_failed",
            cost: null,
          });
        });
      };
      const endAttempt = () => {
        if (settled) return false;
        settled = true;
        const conversation = conversationId ?? resumeCursor;
        if (conversation && checkpointed) systemHeld.forget(conversation);
        else if (conversation && system && promptAccepted) systemHeld.record(conversation, turn.system!);
        else if (conversation) systemHeld.keep(conversation);
        clearTimeout(watchdog);
        armPostSettleCleanup();
        return true;
      };
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: TurnUsage,
      ) => {
        if (!endAttempt()) return;
        active.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok,
          stopReason,
          cost,
          ...(usage ? { usage } : {}),
          ...(promptAccepted ? { promptAccepted: true } : {}),
        });
      };

      // Set only by a user Stop; the watchdog and post-settle reaper kill the
      // child without it.
      let interrupted = false;
      // agy's config is global, so every turn holds the MCP lock for its
      // complete child lifetime; only a computer turn holds it alone.
      const computer = antigravityComputerMcpServer(turn.integrations);
      const args = buildAntigravityTurnArgv({
        fullAuto: config.fullAuto,
        cwd,
        model: turn.model,
        resumeCursor,
        readOnly: turn.readOnly,
      });
      // a computer turn's mount carries its box token, so it never runs on or leaves a standby
      const ordinary = computer === null;
      const taken = ordinary && !relaunchOf
        ? takeStandby(threadId, launchFingerprint(config.cli, args, cwd, childEnv, turn), resumeCursor)
        : {};
      const standby = taken.standby;
      const mcpLock = standby ? undefined : acquireAntigravityMcpLock(computer !== null);
      // Reserve the thread across the lock wait so a Stop lands here.
      active.set(threadId, {
        stop: () => {},
        interrupt: () => {
          interrupted = true;
          mcpLock?.cancel();
        },
        turnId,
      });
      emit({ ...base(threadId, turnId), type: "turn.started" });
      if (taken.dying) await taken.dying;
      let releaseMcpLock: () => void;
      let restoreMcp = () => {};
      let child: ReturnType<typeof spawnCli>;
      if (standby) {
        ({ releaseMcpLock, restoreMcp, child } = standby);
      } else {
        releaseMcpLock = await mcpLock!.granted;
        if (interrupted) {
          releaseMcpLock();
          settle(false, "interrupted");
          return { turnId };
        }
        if (disposed) {
          releaseMcpLock();
          settle(false, "disposed");
          return { turnId };
        }
        try {
          restoreMcp = mountAntigravityMcp(computer, env());
        } catch (error) {
          releaseMcpLock();
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `could not update Antigravity's MCP config (${join(".gemini", "config", "mcp_config.json")}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          settle(false, "mcp_config_error");
          return { turnId };
        }

        // Remaining argv (paths, model, conversation id) can still blow the
        // Windows CreateProcess ceiling even with the prompt on stdin.
        if (process.platform === "win32" && estimateWin32CmdlineLength(config.cli, args) > WIN32_CREATEPROCESS_CMDLINE_MAX) {
          try {
            restoreMcp();
          } finally {
            releaseMcpLock();
          }
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `spawn failed: command line too long for Windows (${estimateWin32CmdlineLength(config.cli, args)} chars > ${WIN32_CREATEPROCESS_CMDLINE_MAX})`,
            setup: false,
          });
          settle(false, "spawn_error");
          return { turnId };
        }

        // spawnCli resolves npm .cmd shims / shebang scripts on Windows and
        // owns the process-group vs windowsHide difference (see procs.ts)
        try {
          child = spawnCli(config.cli, args, {
            cwd,
            env: childEnv,
            stdio: ["pipe", "pipe", "pipe"], // prompt on stdin as stream-json NDJSON
          });
        } catch (error) {
          try {
            restoreMcp();
          } finally {
            releaseMcpLock();
          }
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            ...describeSpawnFailure(error instanceof Error ? error : new Error(String(error)), config.cli, cwd),
          });
          settle(false, "spawn_error");
          return { turnId };
        }
        children.add(child);
      }

      // Deliver the full prompt (system/persona + user text, continuity included)
      // as one stream-json user event, then close stdin so one-shot print exits
      // after the turn — same lifecycle as the old --print argv path.
      const stdinLine = antigravityStreamUserLine(prompt);
      try {
        const stdin = child.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
          throw new Error("agy stdin is not writable");
        }
        stdin.write(stdinLine, (writeError) => {
          if (writeError) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `failed to write Antigravity prompt to stdin: ${writeError.message}`,
            });
            settle(false, "stdin_write_failed");
            killCliTree(child);
          }
        });
        stdin.end();
      } catch (error) {
        try {
          restoreMcp();
        } finally {
          releaseMcpLock();
        }
        children.delete(child);
        try {
          killCliTree(child);
        } catch {}
        standby?.lease.release("stdin");
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `failed to write Antigravity prompt to stdin: ${error instanceof Error ? error.message : String(error)}`,
        });
        settle(false, "stdin_write_failed");
        return { turnId };
      }

      let childClosed = false;
      // the conversation a clean reply leaves, for the thread's next standby
      let next: string | null = null;
      let postSettleReaper: ReturnType<typeof setTimeout> | undefined;
      let terminationEscalation: ReturnType<typeof setTimeout> | undefined;
      let mcpFinalized = false;
      const finalizeMcp = () => {
        if (mcpFinalized) return;
        mcpFinalized = true;
        try {
          restoreMcp();
        } catch (error) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `could not restore Antigravity's MCP config: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          releaseMcpLock();
        }
      };
      const armTerminationEscalation = () => {
        if (childClosed || terminationEscalation) return;
        terminationEscalation = setTimeout(() => {
          if (childClosed) return;
          if (process.platform === "win32") {
            killCliTree(child); // taskkill /T /F is already forceful
            return;
          }
          try {
            const pid = child.pid;
            if (pid) process.kill(-pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, 3_000);
        terminationEscalation.unref?.();
      };
      const stop = () => {
        killCliTree(child); // process groups are POSIX-only
        armTerminationEscalation();
      };
      armPostSettleCleanup = () => {
        if (childClosed || postSettleReaper) return;
        // A normal agy process exits immediately after `result`. Give it a
        // short grace, then reap a zombie. Explicit stops use the same bounded
        // SIGKILL escalation so an uncooperative child cannot retain the lock.
        postSettleReaper = setTimeout(stop, 2_000);
        postSettleReaper.unref?.();
      };

      let cancelledTool = false;
      let toolRan = false;
      let lastStepType: string | undefined;
      let lastStepState: string | undefined;
      // every text_delta so far, and the shown text already streamed from it
      let deltaText = "";
      let streamed = "";
      const steps = new Map<number, string>();
      const streamDelta = (delta: string) => {
        deltaText += delta;
        if (cancelledTool) return;
        const shown = stripAntigravitySystemNotices(deltaText);
        const ready = shown.slice(0, unfinishedNoticeStart(shown));
        if (ready.length <= streamed.length || !ready.trim() || !ready.startsWith(streamed)) return;
        // a busy resume repeating text already shown holds until it differs
        if ([...shownResponses].some((text) => text.startsWith(ready))) return;
        emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: ready.slice(streamed.length) });
        streamed = ready;
      };

      // A busy resume is the same logical turn, so its usage carries forward.
      const withPriorUsage = (usage: { input_tokens?: number; cache_read_tokens?: number; output_tokens?: number }): TurnUsage => ({
        input: priorUsage.input + (usage.input_tokens || 0) + (usage.cache_read_tokens || 0),
        output: priorUsage.output + (usage.output_tokens || 0),
        ...(typeof usage.cache_read_tokens === "number" || priorUsage.cachedInput !== undefined
          ? { cachedInput: (priorUsage.cachedInput ?? 0) + (usage.cache_read_tokens || 0) }
          : {}),
      });

      // The thread stays held through the wait so Stop or a new message cancels it.
      const resumeWhenFree = (conversation: string, reason: string, attemptUsage: TurnUsage) => {
        endAttempt();
        const abort = new AbortController();
        active.set(threadId, { stop: () => abort.abort(), interrupt: () => abort.abort(), turnId });
        const delayMs = BUSY_RESUME_DELAYS_MS[busyResumes];
        emit({ ...base(threadId, turnId), type: "turn.retrying", attempt: busyResumes + 1, delayMs, reason });
        void interruptibleDelay(delayMs, abort.signal).promise.then(async (outcome) => {
          active.delete(threadId);
          if (outcome === "cancelled" || disposed) {
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null, promptAccepted: true });
            return;
          }
          await sendTurn(
            { ...turn, text: AGY_BUSY_RESUME_PROMPT, resumeCursor: conversation, resumeFallback: undefined },
            turnId,
            busyResumes + 1,
            attemptUsage,
            shownResponses,
          );
        }).catch((error) => {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "busy_resume_failed", cost: null });
        });
      };

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "agy.stream", msg: o });
        const payload = o[o.event] ?? {};
        switch (o.event) {
          case "init": {
            conversationId = o.conversation_id ?? null;
            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId: conversationId,
              model: turn.model ?? null,
            });
            break;
          }
          case "step_update": {
            promptAccepted = true;
            lastStepType = payload.step_type;
            lastStepState = payload.state;
            if (payload.step_type === "checkpoint") checkpointed = true;
            if (payload.step_type === "tool") {
              toolRan = true;
              cancelledTool ||= isCancelledTool(payload);
              const itemId = `${conversationId ?? o.conversation_id ?? "conv"}:${payload.step_index}`;
              if (payload.state === "ACTIVE") {
                emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId, title: payload.tool_name && originalCatalogCall(payload.tool_name, payload.tool_info?.parameters, "agents").name });
              } else if (payload.state === "DONE") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
              } else if (payload.state === "ERROR") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: false });
              }
            } else if (payload.step_type === "agent_response") {
              if (typeof payload.text_delta === "string") {
                steps.set(payload.step_index, (steps.get(payload.step_index) ?? "") + payload.text_delta);
                streamDelta(payload.text_delta);
              }
              if (payload.usage) emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...withPriorUsage(payload.usage) });
            }
            break;
          }
          case "result": {
            promptAccepted = true;
            // result.response is every text_delta joined; a later step restating an earlier one drops it
            const joined = typeof payload.response === "string" ? payload.response : "";
            const parts = [...steps.values()];
            const response = stripAntigravitySystemNotices(parts.join("") === joined ? unrestated(parts).join("") : joined);
            const realResponse = Boolean(response.trim()) && !cancelledTool;
            const parsedError = z.string().safeParse(payload.error);
            const agyError = parsedError.success ? parsedError.data : "";
            const agyResultError = payload.status === "ERROR" && agyError.length > 0;
            const busyReason =
              agyResultError && !cancelledTool && !interrupted && !isAgyAccountError(agyError)
                ? busyResumeReason(agyError)
                : null;
            if (
              agyResultError && !realResponse && !toolRan && !interrupted &&
              resumeCursor && turn.resumeFallback && AGY_SIGNATURES_REFUSED.test(agyError)
            ) {
              relaunchFresh(conversationId ?? resumeCursor);
              break;
            }
            const recoveredTransient = agyResultError && realResponse && lastStepType === "agent_response" && lastStepState === "DONE"
              && (busyReason !== null || AGY_NOT_ACCOUNT_ERROR.test(agyError) || (AGY_TIMEOUT_ERROR.test(agyError) && !AGY_ACCOUNT_ERROR.test(agyError)));
            if (realResponse && !shownResponses.has(response)) {
              shownResponses.add(response);
              // item.completed carries the reply; a result that disagrees with the stream adds no delta
              const rest = response.startsWith(streamed) ? response.slice(streamed.length) : "";
              if (rest) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: rest });
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: response });
            }
            const conversation = conversationId ?? resumeCursor;
            if (busyReason && !recoveredTransient && conversation && busyResumes < BUSY_RESUME_DELAYS_MS.length) {
              resumeWhenFree(conversation, busyReason, payload.usage ? withPriorUsage(payload.usage) : priorUsage);
              break;
            }
            if (ordinary && payload.status === "SUCCESS" && realResponse && !interrupted) next = conversation;
            if (agyResultError && !recoveredTransient) {
              if (isAgyAccountError(agyError)) {
                emit({ ...base(threadId, turnId), type: "runtime.error", message: agyError, signIn: true });
              } else {
                emit({ ...base(threadId, turnId), type: "runtime.error", message: agyError });
              }
              if (busyReason && busyResumes > 0) emit({ ...base(threadId, turnId), type: "runtime.error", message: AGY_STILL_BUSY });
            }
            if (!realResponse && !agyResultError) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: AGY_STOPPED_NOTE });
            }
            if (payload.usage) {
              emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...withPriorUsage(payload.usage) });
            }
            // result.usage is the turn total (the per-step agent_response
            // figures above are its parts, not additions to it)
            settle(
              (payload.status === "SUCCESS" && realResponse) || recoveredTransient,
              cancelledTool
                ? "cancelled_tool"
                : recoveredTransient
                  ? "recovered_transient_error"
                  : realResponse
                    ? payload.status ?? null
                    : "no_final_text",
              null,
              payload.usage
                ? {
                    input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                    output: payload.usage.output_tokens || 0,
                    ...(typeof payload.usage.cache_read_tokens === "number" ? { cachedInput: payload.usage.cache_read_tokens } : {}),
                  }
                : undefined,
            );
            break;
          }
        }
      };

      let buf = standby?.partial ?? "";
      child.stdout.setEncoding("utf8"); // decode multibyte across chunk splits
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line);
        }
      });

      let stderr = standby?.stderr ?? "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli, cwd) });
        settle(false, "spawn_error");
      });

      child.on("close", (code) => {
        childClosed = true;
        children.delete(child); // close is the true process-exit signal
        clearTimeout(postSettleReaper);
        clearTimeout(terminationEscalation);
        standby?.lease.release("used");
        // agy has saved the turn once it exits
        if (next && !mcpFinalized && epoch === warmPool.generation(warmKey(threadId))) {
          mcpFinalized = true;
          startStandby(threadId, next, turn, cwd, childEnv, { restoreMcp, releaseMcpLock });
        } else finalizeMcp();
        if (!settled) {
          if (interrupted) {
            settle(false, "interrupted");
            return;
          }
          const resumeRejected = Boolean(
            resumeCursor &&
            turn.resumeFallback &&
            !conversationId &&
            isResumeCursorRejected(stderr),
          );
          if (resumeRejected) {
            relaunchFresh(resumeCursor);
            return;
          }
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `agy exited ${code} before result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, {
        stop,
        interrupt: () => {
          interrupted = true;
          stop();
        },
        turnId,
      });

      // 61 min - just above agy's own 60m --print-timeout, so agy normally
      // settles first; this is the backstop for a fully wedged child.
      watchdog = setTimeout(() => {
        if (!settled) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "agy watchdog timeout" });
          stop();
          settle(false, "timeout");
        }
      }, 61 * 60_000);
      watchdog.unref?.();
      for (const line of standby?.lines ?? []) handleLine(line);

      return { turnId };
    };

    const snapshot = async (opts?: { rescan?: boolean; refresh?: boolean }): Promise<ProviderSnapshot> => {
      const { version, missing } = await new Promise<{ version: string | null; missing: boolean }>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env: env() }, (err, stdout) =>
          resolve({ version: err ? null : stdout.trim(), missing: err !== null && "code" in err && err.code === "ENOENT" }),
        );
      });
      // Only a failed lookup is Not Installed; a slow or failing agy is installed but not answering.
      if (!version) return missing ? cliNotFound(config.cli) : { state: "unavailable", reason: `\`${config.cli}\` did not answer --version` };
      const authenticated = await signIn.check(opts?.rescan || opts?.refresh);
      const account = authenticated ? readAntigravityAccount(env()) : undefined;
      // a sign-in made outside Wink changes agy's account under the idle standbys
      if ([...standbyOf.values()].some((standby) => standby.account !== account)) void retireStandbys("account changed");
      return { state: "available", version, authenticated, account };
    };

    const textModelDenied = new Set<string>();

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      // undefined once agy denies this account the text model: notes then run on the bot's own model
      get textModel() {
        return textModelDenied.size && textModelDenied.has(readAntigravityAccount(env()) ?? "") ? undefined : AGY_TEXT_MODEL;
      },
      refreshModels,
      snapshot,
      loginConfig: () => ({
        cli: `"${process.execPath}" "${SPAWNED_PROXIES.antigravityAuth}"`,
        env: { ...env(), ELECTRON_RUN_AS_NODE: "1", OMB_AGY_CLI: config.cli },
      }),
      // agy older than 1.5 has no ACP logout, and could not update to get one: delete its saved sign-in instead.
      signOutWithoutCli: async (failure) => {
        if (failure !== "update_offline" && failure !== "update_failed") return false;
        await retireStandbys("sign-out");
        return keyringSignOut.signOut();
      },
      signingIn: async () => {
        await retireStandbys("sign-in");
        return keyringSignOut.signingIn();
      },
      signedOutByCli: () => {
        void retireStandbys("signed out");
        keyringSignOut.signedOutByAgy();
      },
      // a chat with a conversation gets its standby when its last turn exits
      prepare: async (_shape?: PrepareTurn, focus?: PrepareFocus) => {
        if (!focus?.fresh || disposed || active.has(focus.threadId) || keyringSignOut.pending || mcpExclusiveWanted()) return;
        const { fresh, ...settings } = focus;
        const turn: SendTurnInput = { ...settings, ...fresh, text: "" };
        if (antigravityComputerMcpServer(turn.integrations) !== null) return;
        const { cwd, childEnv } = launchOf(turn);
        const releaseMcpLock = await acquireAntigravityMcpLock(false).granted;
        let restoreMcp: () => void;
        try {
          restoreMcp = mountAntigravityMcp(null, env());
        } catch {
          releaseMcpLock();
          return;
        }
        startStandby(focus.threadId, null, turn, cwd, childEnv, { restoreMcp, releaseMcpLock });
      },
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          images: true,
          // Usage refresh polls the local agy quota server, so the engine
          // reports subscription windows instead of sitting unreported.
          rateLimits: true,
          // Cloud box, Local VM, and VPS computers all mount through the
          // global mcp_config.json above. Only full-auto instances advertise
          // it: print mode has no interactive approval channel, and outside
          // --dangerously-skip-permissions agy auto-denies tools that would
          // prompt (the accept-edits shell behavior in the header comment),
          // so a non-fullAuto mount could never fire. localComputerMcp stays
          // unset on purpose — the host desktop requires per-action human
          // approval (see contracts.ts), which print mode cannot deliver in
          // any mode; that returns with the native ACP path.
          computerMcp: config.fullAuto,
          // The static agents entry above; each turn's identity rides on its
          // own agy child's env.
          agentsMcp: true,
          // nothing in print mode can ask, so Ask for approval would be a no-op
          askApproval: false,
          readOnlyTurns: true,
        },
        sendTurn,
        access: (turn) => antigravityAccess(buildAntigravityTurnArgv({ fullAuto: config.fullAuto, cwd: "", readOnly: turn.readOnly })),
        interruptTurn: async (threadId) => {
          // a Stop or a bot delete ends the chat's idle standby too
          warmPool.invalidate({ instanceId, threadId }, "stopped");
          active.get(threadId)?.interrupt();
        },
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          reapChildren(false); // also reap children that hung post-result
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt, opts) => {
        const stopped = opts?.signal ?? new AbortController().signal;
        stopped.throwIfAborted();
        const pendingSignOut = keyringSignOut.pending;
        if (pendingSignOut) {
          if (await pendingSignOut) throw new Error("Gemini is not signed in.");
          stopped.throwIfAborted();
        }
        let cwd: string | null = null;
        try {
          const helperEnv = env();
          const home = antigravityHelperHome(helperEnv);
          Object.assign(helperEnv, { HOME: home, USERPROFILE: home });
          const dir = cwd = mkdtempSync(join(tmpdir(), "omb-agy-summary-"));
          let denied = false;
          // stdin like a turn: a summary prompt on argv blows the Windows command line
          const run = (model: string) => new Promise<string>((resolve, reject) => {
            const child = spawnCli(
              config.cli,
              ["--input-format", "stream-json", "--output-format", "stream-json", "--model", model],
              { cwd: dir, env: helperEnv, stdio: ["pipe", "pipe", "pipe"] },
            );
            let result: { status?: unknown; response?: unknown; error?: unknown } | null = null;
            let failure: Error | null = null;
            const stop = (error: Error) => {
              failure ??= error;
              killCliTree(child);
            };
            const abort = () => stop(new Error("agy summary aborted"));
            stopped.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(() => stop(new Error("agy summary timed out")), opts?.timeoutMs ?? 120_000);
            timer.unref?.();
            let buf = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
              buf += chunk;
              let nl;
              while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                try {
                  const o = JSON.parse(line);
                  if (o.event === "result") result = o.result ?? {};
                } catch {}
              }
            });
            let stderr = "";
            child.stderr.on("data", (c) => {
              stderr = (stderr + c).slice(-300);
            });
            child.on("error", (error) => {
              failure ??= error;
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              stopped.removeEventListener("abort", abort);
              const response = typeof result?.response === "string" ? result.response.trim() : "";
              const error = typeof result?.error === "string" ? result.error : undefined;
              denied = !failure && !response && AGY_MODEL_DENIED.test(`${error ?? ""}\n${stderr}`);
              if (failure) reject(failure);
              else if (!result) reject(textUsageError(stderr) ?? new Error(`agy exited ${code} before result${stderr ? `: ${stderr.trim()}` : ""}`));
              else if (result.status !== "SUCCESS" || !response) {
                reject(textUsageError(error) ?? textUsageError(stderr) ?? new Error(`agy summary failed (${String(result.status)})${error && isAgyAccountError(error) ? `: ${error}` : ""}`));
              }
              else resolve(response);
            });
            child.stdin.end(antigravityStreamUserLine(prompt));
          });
          // an account denied the text model writes notes on the bot's own chat model
          const fallback = opts?.fallbackModel && opts.fallbackModel !== AGY_TEXT_MODEL ? opts.fallbackModel : undefined;
          const account = fallback ? readAntigravityAccount(env()) ?? "" : "";
          if (fallback && textModelDenied.has(account)) return await run(fallback);
          try {
            return await run(AGY_TEXT_MODEL);
          } catch (error) {
            if (!fallback || !denied || stopped.aborted) throw error;
            textModelDenied.add(account);
            return await run(fallback);
          }
        } finally {
          try {
            if (cwd) rmSync(cwd, { recursive: true, force: true });
          } catch {}
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        forgetSignedOut();
        warmPool.invalidate({ instanceId, incarnation }, "dispose");
        for (const { stop } of active.values()) stop();
        reapChildren(true); // escalate to SIGKILL — disposal must reap every child
        listeners.clear();
        // Its turns are stopped: a delete waiting on them lands before Wink exits.
        await keyringSignOut.release((turn) => turn.startsWith(`${instanceId}\0`));
      },
    };
  },
};
