import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

import { applyCredentialAllowlist, scrubbedEnv } from "./config.ts";
import type { RateLimitWindow } from "./contracts.ts";
import { acpChildEnv } from "./drivers/acp/core.ts";
import { grokSupport } from "./drivers/acp/grok.ts";
import { classifyMuseError, museDefaultCli, resolveWslMuseCli, withWslKeySharing } from "./drivers/acp/muse.ts";
import { antigravityRateLimitWindows, codexRateLimitWindows, grokRateLimitWindows, museUsageReport, usageLimitFromError } from "./drivers/rate-limits.ts";
import { createMspChannel, MspRpcError, uuidv7 } from "./drivers/msp/protocol.ts";
import { augmentedPath, toWslPath } from "./env-path.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";
import { parseJson, type JsonValue } from "./schema.ts";
import { accountLaunch, type AccountContext } from "./account-policy.ts";
import { awaitDyingAppServers, codexHome, retireAppServer } from "./drivers/codex-catalog.ts";
import { parseCodexAccount } from "./drivers/codex-account.ts";
import { codexDirect } from "./drivers/codex-direct.ts";
import { createClaudeUsageProbe, readClaudeUsage } from "./claude-usage-probe.ts";

type Report = { windows: RateLimitWindow[]; observedAt: string };
export type UsageRefreshStatus =
  | "fresh"
  | "retained"
  | "no_observation"
  | "transport_error"
  | "auth_error"
  | "limit_reached";
type Result = { report?: Report; error?: string; retryAt: number; status?: UsageRefreshStatus; resetsAt?: number | null };
type Options = { instanceId: string; cli?: string; environment?: NodeJS.ProcessEnv; museModel?: string; account?: AccountContext; fresh?: boolean; maxAgeMs?: number };
const usableReport = (report: Report | undefined): report is Report =>
  Boolean(report && report.windows.length > 0 && Number.isFinite(Date.parse(report.observedAt)));
const percent = z.number().finite().nonnegative();
const codexUsageWindow = z.object({ usedPercent: percent }).passthrough();
const codexUsage = z.object({ limitId: z.string().nullish(), primary: codexUsageWindow.nullable().optional(), secondary: codexUsageWindow.nullable().optional() }).passthrough();
const rpcMessage = z.object({ id: z.number().optional(), method: z.string().optional(), result: z.json().optional(), error: z.object({ code: z.number() }).optional() });

export function usageReportWithAge(report: Report, now = Date.now()) {
  return { ...report, ageMs: Math.max(0, now - Date.parse(report.observedAt)) };
}

export function usageRefreshResponse(instanceId: string, result: Result, now = Date.now()) {
  const report = result.report && usageReportWithAge(result.report, now);
  return { instanceId, report, error: result.error, retryAt: result.retryAt, retryInMs: Math.max(0, result.retryAt - now),
    status: result.status, resetsAt: result.resetsAt };
}

export async function readUsageRpc(cli: string, env: NodeJS.ProcessEnv, account?: AccountContext): Promise<JsonValue> {
  const home = account?.home ?? codexHome(env);
  if (account) await awaitDyingAppServers(2_000, home);
  return new Promise((resolve, reject) => {
    const child = spawnCli(cli, ["app-server"], { cwd: homedir(), env: scrubbedEnv(env), stdio: ["pipe", "pipe", "pipe"], direct: codexDirect, ...(account ? { account, accountDriver: "codex" } : {}) });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let usage: JsonValue | undefined;
    let identity: JsonValue | undefined;
    const finish = (value?: JsonValue, code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (account) retireAppServer(child, home);
      else killCliTree(child);
      if (value !== undefined) resolve(value);
      else reject(new Error(code === 401 || code === 403 ? "signin" : "refresh"));
    };
    const send = (method: string, id?: number) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "initialize" ? { clientInfo: { name: "orbit", version: "1" } } : method === "account/read" ? { refreshToken: false } : {} })}\n`); }
      catch { finish(); }
    };
    const timer = setTimeout(() => finish(), 15_000);
    child.stderr.resume();
    child.once("error", () => finish());
    child.once("exit", () => finish());
    lines.on("line", (line) => {
      try {
        const message = rpcMessage.parse(parseJson(line));
        if (message.id !== 1 && message.id !== 2 && message.id !== 3) return;
        if (message.error) return finish(undefined, message.error.code);
        if (message.id === 1) { send("initialized"); send("account/rateLimits/read", 2); if (account) send("account/read", 3); }
        else if (!account) finish(message.result);
        else {
          if (message.id === 2) usage = message.result;
          if (message.id === 3) identity = message.result;
          if (usage !== undefined && identity !== undefined) {
            if (parseCodexAccount(identity).type !== "chatgpt") return finish(undefined, 401);
            finish({ ...z.record(z.string(), z.json()).parse(usage), account: z.object({ account: z.json() }).parse(identity).account });
          }
        }
      } catch { finish(); }
    });
    send("initialize", 1);
  });
}

export function readGrokBillingRpc(cli: string, env: NodeJS.ProcessEnv): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const config = { cli, fullAuto: false };
    const childEnv = acpChildEnv(grokSupport, config, env);
    const child = spawnCli(cli, grokSupport.spawnArgs(config, { threadId: "usage-refresh", text: "" }), { cwd: homedir(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (value?: JsonValue, code?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killCliTree(child);
      if (value !== undefined) resolve(value);
      else reject(new Error(code === 401 || code === 403 ? "signin" : "refresh"));
    };
    const send = (method: string, id?: number, params = {}) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch { finish(); }
    };
    const timer = setTimeout(() => finish(), 15_000);
    child.stderr.resume();
    child.once("error", () => finish());
    child.once("exit", () => finish());
    lines.on("line", (line) => {
      try {
        const message = rpcMessage.parse(parseJson(line));
        if (message.method && message.id !== undefined) {
          try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })}\n`); }
          catch { finish(); }
          return;
        }
        if (message.id !== 1 && message.id !== 2 && message.id !== 3) return;
        if (message.error) return finish(undefined, message.error.code);
        if (message.id === 1) {
          const methods = z.object({ authMethods: z.array(z.object({ id: z.string().optional() })).optional() }).catch({}).parse(message.result);
          const authMethod = grokSupport.pickAuthMethod(methods.authMethods ?? []);
          if (authMethod) send("authenticate", 2, { methodId: authMethod });
          else finish(undefined, 401);
        } else if (message.id === 2 && grokSupport.billingMethod) send(grokSupport.billingMethod, 3);
        else finish(message.result);
      } catch { finish(); }
    });
    send("initialize", 1, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  });
}

const agyQuotaPaths = [
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
  "/exa.language_server_pb.LanguageServerService/GetUserStatus",
] as const;

/** Quota from `agy -p /usage --output-format stream-json`: the CLI prints a
 * structured `command_result` (plus a final `result`, same `command.data`)
 * without spending a token or needing the IDE open, so bars can appear
 * before any chat message. Returns the first `data` payload that reads as
 * quota windows; anything else (exec failure, unparseable output, empty
 * groups) is a refresh error, never signin — a logged-out CLI answers with
 * empty groups and exit 0, indistinguishable from "no quota to report". */
export function readAntigravityUsageCommand(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => Promise<string | null> = (command, args) =>
    new Promise((resolve) => {
      execCli(
        command,
        args,
        { timeout: 20_000, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env, cwd: homedir() },
        (error, stdout) => resolve(error ? null : stdout),
      );
    }),
): Promise<JsonValue> {
  const usageData = (holder: unknown): unknown => {
    const command = holder && typeof holder === "object" ? ((holder as Record<string, unknown>).command as Record<string, unknown> | undefined) : undefined;
    if (!command || typeof command !== "object" || command.name !== "usage") return undefined;
    return command.data;
  };
  const dataOf = (message: unknown): unknown => {
    const record = message && typeof message === "object" ? (message as Record<string, unknown>) : null;
    if (!record) return undefined;
    // Only the two shapes seen live: the command_result line and the final
    // result's nested command. Anything else — another command's result, an
    // unnamed payload, a future shape — is ignored so a foreign data object
    // can never read as quota; unknown output falls through to the RPC leg.
    if (record.event === "command_result") return usageData(record);
    if (record.event === "result") {
      const result = record.result && typeof record.result === "object" ? record.result : null;
      return result ? usageData(result) : undefined;
    }
    return undefined;
  };
  return (async (): Promise<JsonValue> => {
    const out = await run(cli, ["-p", "/usage", "--output-format", "stream-json"]);
    if (!out) throw new Error("refresh");
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = parseJson(line);
      } catch {
        continue;
      }
      const data = dataOf(message);
      if (data !== undefined) {
        try {
          if (antigravityRateLimitWindows(data as JsonValue).length > 0) return data as JsonValue;
        } catch {
          continue;
        }
      }
    }
    throw new Error("refresh");
  })();
}

/** A 401/403 from the quota RPC names its cause: agy 1.2.2+ walls the
 * language server behind a per-boot CSRF secret (`x-codeium-csrf-token`)
 * that only the spawning IDE/CLI knows, so its missing/invalid-token
 * message is an unreachable endpoint — a refresh error — and must never
 * read as the user being signed out. Only those two exact messages match;
 * anything else keeps the legacy signin meaning. */
export function isCsrfRejection(body: string): boolean {
  let message = body.trim();
  try {
    const parsed = parseJson(body) as { message?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") message = parsed.message.trim();
  } catch {
    // not JSON — match against the raw body
  }
  return /^(missing|invalid) CSRF token$/i.test(message);
}

/** Quota from the local Antigravity language server — the same
 * RetrieveUserQuotaSummary RPC behind agy's own `/usage`. The server only
 * exists while agy or the IDE runs, on a random loopback port behind a
 * self-signed cert, so candidates come from the process list and their
 * ports from the listener table; anything missing means "not running", a
 * refresh error rather than a signin one. Loopback only — `rejectUnauthorized: false`
 * is scoped to these calls, never global. Total work stays inside 15s.
 * Fallback only: the /usage command above answers without a running
 * server, and current agy walls this RPC behind CSRF (see
 * isCsrfRejection), so this path survives for older servers. */
export function readAntigravityQuotaRpc(cli: string, env: NodeJS.ProcessEnv): Promise<JsonValue> {
  const started = Date.now();
  const remaining = () => 15_000 - (Date.now() - started);
  const shellEnv = { ...process.env, ...env };
  const run = (command: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { timeout: Math.max(1, remaining()), windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: shellEnv },
        (error, stdout) => resolve(error ? null : stdout),
      );
    });
  const post = (secure: boolean, port: number, path: string): Promise<{ status: number; json: JsonValue; body?: string } | null> =>
    new Promise((resolve) => {
      if (remaining() <= 0) {
        resolve(null);
        return;
      }
      const body = JSON.stringify({ ideName: "antigravity", extensionName: "antigravity", locale: "en", ideVersion: "unknown" });
      const options = {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "connect-protocol-version": "1", "content-length": Buffer.byteLength(body) },
      };
      const done = (response: IncomingMessage) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
          if (text.length > 4 * 1024 * 1024) {
            request.destroy();
            resolve(null);
          }
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status === 401 || status === 403) {
            resolve({ status, json: null, body: text });
            return;
          }
          try {
            resolve({ status, json: parseJson(text) });
          } catch {
            resolve(null);
          }
        });
      };
      const request = secure ? httpsRequest({ ...options, rejectUnauthorized: false }, done) : httpRequest(options, done);
      request.on("timeout", () => {
        request.destroy();
        resolve(null);
      });
      request.on("error", () => resolve(null));
      request.setTimeout(Math.max(1, remaining()));
      request.write(body);
      request.end();
    });
  return (async (): Promise<JsonValue> => {
    const base = cli.split(/[\\/]/).pop()?.trim() || "agy";
    const windows = process.platform === "win32";
    const listing = windows ? await run("tasklist", ["/FO", "CSV", "/NH"]) : await run("ps", ["-ax", "-o", "pid=,command="]);
    const pids = new Set<string>();
    if (listing) {
      for (const line of listing.split("\n")) {
        if (windows) {
          const cells = line.split('","');
          const name = (cells[0] ?? "").replace(/^"/, "").toLowerCase();
          const pid = cells[1] ?? "";
          if (/^\d+$/.test(pid) && (name.includes(base.toLowerCase()) || name.includes("language_server"))) pids.add(pid);
        } else {
          const match = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!match) continue;
          const command = match[2];
          if (
            command.includes(base) ||
            /(^|\/)agy(\s|$)/.test(command) ||
            /antigravity-cli|antigravity_cli/.test(command) ||
            (/language_server|language-server/.test(command) && /antigravity/i.test(command))
          ) {
            if (pids.size < 5) pids.add(match[1]);
          }
        }
      }
    }
    if (pids.size === 0) throw new Error("refresh");
    const ports: number[] = [];
    if (windows) {
      const table = await run("netstat", ["-ano", "-p", "TCP"]);
      if (table) {
        for (const line of table.split("\n")) {
          const cells = line.trim().split(/\s+/);
          if (cells.length >= 4 && cells[3] === "LISTENING" && pids.has(cells[4] ?? "")) {
            const local = cells[1] ?? "";
            const port = Number(local.startsWith("127.0.0.1:") || local.startsWith("[::1]:") ? local.slice(local.lastIndexOf(":") + 1) : "");
            if (Number.isInteger(port) && port > 0 && !ports.includes(port) && ports.length < 4) ports.push(port);
          }
        }
      }
    } else {
      for (const pid of pids) {
        const open = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid]);
        if (!open) continue;
        for (const match of open.matchAll(/(?:127\.0\.0\.1|\[?::1\]?):(\d+)/g)) {
          const port = Number(match[1]);
          if (Number.isInteger(port) && port > 0 && !ports.includes(port) && ports.length < 4) ports.push(port);
        }
        if (ports.length >= 4) break;
      }
    }
    if (ports.length === 0) throw new Error("refresh");
    let auth = false;
    for (const port of ports) {
      if (remaining() <= 0) break;
      for (const secure of [true, false] as const) {
        const quota = await post(secure, port, agyQuotaPaths[0]);
        if (!quota) continue;
        if (quota.status === 401 || quota.status === 403) {
          if (!isCsrfRejection(quota.body ?? "")) auth = true;
          continue;
        }
        if (quota.status === 200 && antigravityRateLimitWindows(quota.json).length > 0) return quota.json;
        const status = await post(secure, port, agyQuotaPaths[1]);
        if (!status) continue;
        if (status.status === 401 || status.status === 403) {
          if (!isCsrfRejection(status.body ?? "")) auth = true;
          continue;
        }
        if (status.status === 200 && antigravityRateLimitWindows(status.json).length > 0) return status.json;
        break;
      }
    }
    throw new Error(auth ? "signin" : "refresh");
  })();
}

/** Antigravity quota for usage refresh: the /usage command first (no
 * running server needed, so bars can appear before any chat message),
 * the language-server RPC scrape as the fallback for older servers.
 * `deps` swaps either leg in tests. */
export function readAntigravityQuota(
  cli: string,
  env: NodeJS.ProcessEnv,
  deps: {
    usage?: typeof readAntigravityUsageCommand;
    rpc?: typeof readAntigravityQuotaRpc;
  } = {},
): Promise<JsonValue> {
  const usage = deps.usage ?? readAntigravityUsageCommand;
  const rpc = deps.rpc ?? readAntigravityQuotaRpc;
  return (async (): Promise<JsonValue> => {
    try {
      return await usage(cli, env);
    } catch {
      return rpc(cli, env);
    }
  })();
}

class MuseUsageFailure extends Error {
  readonly kind: "transport" | "auth" | "limit";
  /** A check turn already reached the model: retrying would spend another message. */
  readonly spent: boolean;
  readonly resetsAt: number | null;

  constructor(kind: "transport" | "auth" | "limit", spent = false, resetsAt: number | null = null) {
    super(kind === "auth" ? "signin" : "refresh");
    this.kind = kind;
    this.spent = spent;
    this.resetsAt = resetsAt;
  }
}

// Check now: limits only arrive inside a model reply, so the check is one tiny
// turn at minimal effort with tools off, in the mode the instance's bots use.
const MUSE_CHECK_MODEL = "muse-spark-1.3";
const MUSE_CHECK_CONTRIBUTOR_MODEL = "muse-spark-1.3-contributor";
const MUSE_CHECK_PROMPT = "Reply with: ok";
const MUSE_CHECK_TURN_MS = 90_000;
const MUSE_CHECK_THROTTLE_MS = 60_000;
const museCheckStarted = z.object({ session: z.object({ sessionId: z.string() }) });
const museCheckCompleted = z.object({ sessionId: z.string(), terminal: z.string().optional(), error: z.unknown().optional(), reason: z.string().optional() });
const museErrorMessage = z.object({ message: z.string() });

/** Contributor only when the instance has bots and all of them run Contributor; Standard otherwise. */
export function museCheckModel(botModels: readonly string[]): string {
  return botModels.length > 0 && botModels.every((model) => model.endsWith("-contributor")) ? MUSE_CHECK_CONTRIBUTOR_MODEL : MUSE_CHECK_MODEL;
}

/** Read the stable MSP usage snapshot from a normal `muse serve` host. With
 * `check`, a memory-only host in an empty temp folder runs one turn first. */
async function readMuseUsageOnce(cli: string, childEnv: NodeJS.ProcessEnv, check = false, model = MUSE_CHECK_MODEL): Promise<JsonValue> {
  const cwd = check ? mkdtempSync(join(tmpdir(), "omb-muse-check-")) : homedir();
  const args = check ? ["serve", "--no-session-log", "--disable-shell", "--disable-write"] : ["serve"];
  const child = spawnCli(cli, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  const channel = createMspChannel(child);
  let failed = false;
  let spent = false;
  child.once("error", () => {
    failed = true;
    channel.detach();
  });
  const request = (method: string, params: JsonValue | undefined, timeoutMs = 15_000) =>
    failed ? Promise.reject(new Error("refresh")) : channel.request(method, params, timeoutMs);
  const runCheckTurn = async () => {
    const workspaceRoot = /^\s*wsl(\.exe)?(\s|$)/i.test(cli) ? toWslPath(cwd) : cwd;
    const started = await request(
      "session/start",
      { commandId: uuidv7(), workspaceRoot, modelId: model, approvalMode: "denyUnmatched" },
      30_000,
    );
    const session = museCheckStarted.safeParse(started);
    if (!session.success) throw new Error("refresh");
    const { sessionId } = session.data.session;
    const cleanup: Array<() => void> = [];
    try {
      const completed = new Promise<z.infer<typeof museCheckCompleted>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("refresh")), MUSE_CHECK_TURN_MS);
        cleanup.push(() => clearTimeout(timer));
        cleanup.push(channel.onExit(() => reject(new Error("refresh"))));
        cleanup.push(channel.onNotification((method, params) => {
          const turn = museCheckCompleted.safeParse(params);
          if (method === "turn/completed" && turn.success && turn.data.sessionId === sessionId) resolve(turn.data);
        }));
      });
      completed.catch(() => undefined);
      const ack = await request(
        "turn/start",
        { commandId: uuidv7(), sessionId, input: [{ type: "text", text: MUSE_CHECK_PROMPT }], reasoningEffort: "minimal" },
        30_000,
      );
      if (ack?.status !== "accepted") throw new Error("refresh");
      spent = true;
      const result = await completed;
      if (result.terminal === "failed" && classifyMuseError(result.error) === "invalid_credentials") {
        throw new MuseUsageFailure("auth", true);
      }
      if (result.terminal === "failed") {
        const message = museErrorMessage.safeParse(result.error).data?.message ?? result.reason ?? "";
        if (usageLimitFromError(new Error(message), true)) {
          const resetsAt = /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(message)?.[1];
          throw new MuseUsageFailure("limit", true, resetsAt ? Date.parse(resetsAt) : null);
        }
      }
    } finally {
      for (const stop of cleanup) stop();
    }
  };
  return (async () => {
    try {
      await request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "orbit", version: "1.0.8" },
          capabilities: { userInputDialogs: false },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        },
      );
      channel.notify("initialized", {});
      if (check) await runCheckTurn();
      return await request("usage/read", undefined) as JsonValue;
    } catch (error) {
      if (error instanceof MuseUsageFailure) throw error;
      if (
        (error instanceof MspRpcError && (error.code === 401 || error.code === 403)) ||
        classifyMuseError(error) === "invalid_credentials"
      ) throw new MuseUsageFailure("auth", spent);
      throw new MuseUsageFailure("transport", spent);
    } finally {
      channel.detach();
      killCliTree(child);
      if (check) {
        const removeCwd = () => {
          try {
            rmSync(cwd, { recursive: true, force: true });
          } catch {
            // an empty temp folder the OS reclaims
          }
        };
        if (child.exitCode !== null || child.signalCode !== null) removeCwd();
        else child.once("exit", removeCwd);
      }
    }
  })();
}

type MuseUsageReadOptions = {
  platform?: NodeJS.Platform;
  resolveWsl?: typeof resolveWslMuseCli;
  check?: boolean;
  model?: string;
};

const isMuseNoObservation = (payload: unknown): boolean => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return Object.keys(record).length === 0 || ("usage" in record && (record.usage === null || record.usage === undefined));
};

export async function readMuseUsage(
  cli = museDefaultCli(),
  env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() },
  options: MuseUsageReadOptions = {},
): Promise<JsonValue> {
  const platform = options.platform ?? process.platform;
  const childEnv = { ...env };
  applyCredentialAllowlist(childEnv, ["META_API_KEY"]);
  if (platform === "win32") withWslKeySharing(childEnv);
  const resolveWsl = options.resolveWsl ?? resolveWslMuseCli;
  const isWindows = platform === "win32";
  const isWsl = /^\s*wsl(\.exe)?(\s|$)/i.test(cli);
  const targets: string[] = [];
  if (isWindows && isWsl) {
    targets.push((await resolveWsl(cli, childEnv)) ?? cli);
  } else {
    targets.push(cli);
  }
  let lastError: unknown;
  for (const target of targets) {
    try {
      return await readMuseUsageOnce(target, childEnv, options.check, options.model);
    } catch (error) {
      if (error instanceof Error && error.message === "signin") throw error;
      if (error instanceof MuseUsageFailure && error.spent) throw error;
      lastError = error;
    }
  }
  if (isWindows && !isWsl && /^\s*muse\s*$/i.test(cli)) {
    const wslCli = await resolveWsl(cli, childEnv);
    if (wslCli) {
      try {
        return await readMuseUsageOnce(wslCli, childEnv, options.check, options.model);
      } catch (error) {
        if (error instanceof Error && error.message === "signin") throw error;
        if (error instanceof MuseUsageFailure && error.spent) throw error;
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("refresh");
}

export function canRefreshUsage(driver: string, environment: NodeJS.ProcessEnv = {}, platform = process.platform, account?: AccountContext): boolean {
  if (account && driver === "claudeAgent") return true;
  return ["claudeAgent", "codex", "grokAgent", "antigravityAgent", "museAgent"].includes(driver)
    && (driver !== "claudeAgent" || platform !== "darwin" || Boolean(({ ...process.env, ...environment }).CLAUDE_CODE_OAUTH_TOKEN));
}

export function createUsageRefresh(deps: {
  rpc?: typeof readUsageRpc;
  billing?: typeof readGrokBillingRpc;
  antigravity?: typeof readAntigravityQuota;
  muse?: typeof readMuseUsage;
  now?: () => number;
  platform?: NodeJS.Platform;
  throttleMs?: number;
  accountIdentity?: (account: AccountContext, identity: string | undefined) => Promise<void>;
  accountBlocked?: (instanceId: string) => boolean;
  claude?: typeof readClaudeUsage;
  random?: () => number;
} = {}) {
  const clock = deps.now ?? Date.now;
  const claudeProbe = createClaudeUsageProbe({ read: deps.claude, now: clock, random: deps.random });
  const cache = new Map<string, { retryAt: number; settled: boolean; pending: Promise<Result> }>();
  const credentials = new Map<string, string>();
  const skipped = new Set<string>();
  const epochs = new Map<string, number>();
  const active = new Map<string, number>();
  const skipWindow = (name: string, id: string) => {
    if (skipped.has(`${name}:${id}`)) return;
    skipped.add(`${name}:${id}`);
    console.warn(`usage-refresh: skipped unreadable ${name} window ${id}`);
  };
  const refresh = async (driver: string, options: Options, previous?: Report): Promise<Result> => {
    if (deps.accountBlocked?.(options.instanceId)) return { report: previous, error: "This account is stopped", retryAt: 0, status: "no_observation" };
    const name = driver === "claudeAgent" ? "Claude" : driver === "codex" ? "Codex" : driver === "grokAgent" ? "Grok" : driver === "antigravityAgent" ? "Antigravity" : driver === "museAgent" ? "Muse" : undefined;
    if (!name) return { report: previous, error: "Usage refresh is not supported", retryAt: 0 };
    // Claude reads are cached per login by its probe below.
    const key = options.account ? `${options.instanceId}:${options.account.generation}` : options.instanceId;
    const epoch = epochs.get(options.instanceId);
    const cached = driver === "claudeAgent" ? undefined : cache.get(key);
    if (cached && (!cached.settled || (!options.fresh && clock() < cached.retryAt))) return cached.pending;
    const retryAt = clock() + (deps.throttleMs ?? 30_000);
    active.set(options.instanceId, (active.get(options.instanceId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (active.get(options.instanceId) ?? 1) - 1;
      if (count) active.set(options.instanceId, count);
      else active.delete(options.instanceId);
    };
    const pending = (async (): Promise<Result> => {
      try {
        const merged: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath(), ...options.environment };
        const env = options.account ? accountLaunch(options.account, driver, [], merged).env : merged;
        const home = env.HOME || env.USERPROFILE || homedir();
        let windows: RateLimitWindow[];
        let observedAt: string | undefined;
        if (driver === "codex") {
          const payload = await (deps.rpc ?? readUsageRpc)(options.cli || "codex", env, options.account);
          if (options.account) {
            if (epochs.get(options.instanceId) !== epoch) return { retryAt: 0 };
            const identity = parseCodexAccount(payload);
            if (identity.type !== "chatgpt") throw new Error("signin");
            release();
            await deps.accountIdentity?.(options.account, identity.identity);
          }
          const result = z.object({ rateLimits: z.json(), rateLimitsByLimitId: z.record(z.string(), z.json()).optional() }).parse(payload);
          const rateLimits = codexUsage.parse(result.rateLimits);
          windows = codexRateLimitWindows(rateLimits);
          for (const [id, snapshot] of Object.entries(result.rateLimitsByLimitId ?? {})) {
            // the map lists the default bucket again under its own limitId
            if (id === (rateLimits.limitId ?? "codex")) continue;
            const bucket = codexRateLimitWindows(snapshot);
            if (!bucket.length) skipWindow(name, id);
            windows.push(...bucket.map((window) => ({ ...window, id: `${id}:${window.id}` })));
          }
        } else if (driver === "grokAgent") {
          const billing = deps.billing ?? readGrokBillingRpc;
          windows = grokRateLimitWindows(await billing(options.cli || "grok", env));
          // grok's first answer after renewing an expired login can lack the plan tier
          if (!windows.length) windows = grokRateLimitWindows(await billing(options.cli || "grok", env));
        } else if (driver === "antigravityAgent") {
          windows = antigravityRateLimitWindows(await (deps.antigravity ?? readAntigravityQuota)(options.cli || "agy", env), clock());
        } else if (driver === "museAgent") {
          const payload = await (deps.muse ?? readMuseUsage)(options.cli || museDefaultCli(), env, { model: options.museModel });
          const report = museUsageReport(payload);
          if (!report) {
            if (isMuseNoObservation(payload)) return { report: previous, status: "no_observation", retryAt };
            throw new MuseUsageFailure("transport");
          }
          windows = report.windows;
          observedAt = report.observedAt;
        } else {
          if (!canRefreshUsage(driver, env, deps.platform, options.account)) return { report: previous, error: "Claude refresh skipped to avoid Keychain prompts on macOS", retryAt };
          // One read per login, not per instance: every instance on a config dir shares it.
          const login = options.account?.id ?? (env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
          if (!options.account) credentials.set(options.instanceId, login);
          const report = await claudeProbe(options.cli || "claude", env, options.account, login, options);
          if (!report) return { report: previous, retryAt, status: "no_observation" };
          windows = report.windows;
          observedAt = report.observedAt;
        }
        if (!windows.length) throw new Error("refresh");
        const report = { windows, observedAt: observedAt ?? new Date(clock()).toISOString() };
        if (observedAt !== undefined && usableReport(previous) && Date.parse(report.observedAt) <= Date.parse(previous.observedAt)) {
          return { report: previous, status: "retained", retryAt };
        }
        return { report, ...(driver === "museAgent" ? { status: "fresh" as const } : {}), retryAt };
      } catch (error) {
        if (error instanceof MuseUsageFailure && error.kind === "limit") {
          return { report: previous, status: "limit_reached", resetsAt: error.resetsAt, retryAt };
        }
        const auth = error instanceof MuseUsageFailure
          ? error.kind === "auth"
          : error instanceof Error && error.message === "signin";
        return {
          report: previous,
          ...(driver === "museAgent" ? { status: auth ? "auth_error" as const : "transport_error" as const } : {}),
          error: auth ? `Sign in again in ${name}` : `Could not refresh ${name} limits`,
          retryAt,
        };
      }
    })();
    const guarded = pending.then((result) => epochs.get(options.instanceId) !== epoch ? { retryAt: 0 } : result)
      .finally(release);
    if (driver !== "claudeAgent") {
      const entry = { retryAt, settled: false, pending: guarded };
      const settle = () => { entry.settled = true; };
      guarded.then(settle, settle);
      cache.set(key, entry);
    }
    return guarded;
  };
  return Object.assign(refresh, { busy: (instanceId: string) => active.has(instanceId), invalidate: (instanceId: string) => {
    epochs.set(instanceId, (epochs.get(instanceId) ?? 0) + 1);
    claudeProbe.invalidate(instanceId);
    const credential = credentials.get(instanceId);
    if (credential) claudeProbe.invalidate(credential);
    for (const key of cache.keys()) if (key === instanceId || key.startsWith(`${instanceId}:`)) cache.delete(key);
  } });
}

/** Check now: one paid Muse turn, at most once a minute per instance. */
export function createMuseCheck(deps: Parameters<typeof createUsageRefresh>[0] = {}) {
  const refresh = createUsageRefresh({
    muse: (cli, env, read) => readMuseUsage(cli, env, { ...read, check: true }),
    ...deps,
    throttleMs: MUSE_CHECK_THROTTLE_MS,
  });
  return Object.assign((options: Options, previous?: Report) => refresh("museAgent", options, previous), { invalidate: refresh.invalidate });
}
