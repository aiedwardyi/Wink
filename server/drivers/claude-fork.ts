// Read-only fork of a thread's Claude session for the quick helper. It is the
// main turn's exact spawn plus --resume --fork-session --no-session-persistence:
// the same args, MCP servers and model keep the main's prompt cache (removing
// tools drops it to 0-5%), so tools are stopped by a PreToolUse hook merged
// into the same --settings instead, and nothing is written for the fork.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { SideEvent, SideHandle, SideInput } from "../contracts.ts";
import { brokerSocketPath, killCliTree, spawnCli } from "../procs.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";

const HOOK_PATH = join(SERVER_ROOT, "drivers", "side-hook.cjs");

export interface ClaudeSpawn {
  cli: string;
  /** the main turn's argv, before --resume / --session-id */
  args: string[];
  mcpServers: Record<string, unknown>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  policy: Pick<Parameters<typeof spawnCli>[2], "account" | "accountDriver" | "accountBaseHome">;
  cursor: string;
}

// Where the CLI writes its per-folder MCP logs (env-paths "claude-cli").
function mcpLogDir(env: NodeJS.ProcessEnv, cwd: string): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const cache =
    process.platform === "win32" ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "claude-cli-nodejs", "Cache")
    : process.platform === "darwin" ? join(home, "Library", "Caches", "claude-cli-nodejs")
    : join(env.XDG_CACHE_HOME || join(home, ".cache"), "claude-cli-nodejs");
  return join(cache, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function usage(raw: any): Extract<SideEvent, { type: "done" }>["usage"] {
  if (!raw) return undefined;
  return {
    input: (raw.input_tokens || 0) + (raw.cache_read_input_tokens || 0) + (raw.cache_creation_input_tokens || 0),
    output: raw.output_tokens || 0,
    ...(typeof raw.cache_read_input_tokens === "number" ? { cachedInput: raw.cache_read_input_tokens } : {}),
  };
}

export function forkClaude(spawn: ClaudeSpawn, input: SideInput): SideHandle {
  const tempDir = mkdtempSync(join(tmpdir(), "omb-side-"));
  try {
    const args = [...spawn.args];
    const mcpServers = structuredClone(spawn.mcpServers) as Record<string, { args?: string[] }>;
    // Same server and tool list, but no broker listens: a permission ask can only fail closed.
    if (mcpServers.ogb?.args) mcpServers.ogb.args[1] = brokerSocketPath(tempDir, `side-${randomUUID().slice(0, 8)}`);
    const mcpConfig = join(tempDir, "mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers }), { mode: 0o600 });
    const at = args.indexOf("--mcp-config");
    if (at !== -1) args[at + 1] = mcpConfig;
    const system = args.indexOf("--append-system-prompt");
    if (system !== -1) {
      const systemPath = join(tempDir, "system.txt");
      writeFileSync(systemPath, args[system + 1]!, { mode: 0o600 });
      args.splice(system, 2, "--append-system-prompt-file", systemPath);
    }
    writeFileSync(join(tempDir, "side-hook.json"), JSON.stringify({ roots: [spawn.cwd] }));
    const command = [process.execPath, HOOK_PATH, tempDir].map((part) => `"${part.replaceAll("\\", "/")}"`).join(" ");
    const hook = { matcher: "*", hooks: [{ type: "command", command }] };
    const settingsAt = args.indexOf("--settings");
    const settings = settingsAt === -1 ? {} : JSON.parse(args[settingsAt + 1]!);
    const merged = JSON.stringify({ ...settings, hooks: { PreToolUse: [hook] } });
    if (settingsAt === -1) args.push("--settings", merged);
    else args[settingsAt + 1] = merged;
    const effort = args.indexOf("--effort");
    // xhigh/max think for seconds before a one-line answer; the CLI keeps the cache across effort
    if (effort !== -1 && ["xhigh", "max"].includes(args[effort + 1]!)) args[effort + 1] = "low";
    args.push("--resume", spawn.cursor, "--fork-session", "--no-session-persistence");

    const env: NodeJS.ProcessEnv = { ...spawn.env, ELECTRON_RUN_AS_NODE: "1" };
    const child = spawnCli(spawn.cli, args, { ...spawn.policy, cwd: spawn.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const live: SideHandle["live"] = {
      pid: child.pid ?? 0,
      procStart: Date.now(),
      cwd: spawn.cwd,
      tempDir,
      configDir: env.CLAUDE_CONFIG_DIR || join(env.HOME || env.USERPROFILE || homedir(), ".claude"),
      mcpLogDir: mcpLogDir(env, spawn.cwd),
    };
    const listeners = new Set<(event: SideEvent) => void>();
    const emit = (event: SideEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    let finished = false;
    let last = "";
    let session = "";
    const lookups = new Map<string, string>();
    const finish = (ok: boolean, text: string, used?: ReturnType<typeof usage>) => {
      if (finished) return;
      finished = true;
      emit({ type: "done", ok, text, usage: used });
    };
    const exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const onLine = (line: string) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m?.parent_tool_use_id) return;
      if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string" && m.session_id !== session) {
        session = m.session_id;
        emit({ type: "session", id: m.session_id });
      } else if (m.type === "stream_event") {
        const event = m.event;
        if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") emit({ type: "tool", name: String(event.content_block.name) });
        else if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") emit({ type: "text", delta: String(event.delta.text ?? "") });
      } else if (m.type === "assistant") {
        const blocks: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
        const text = blocks.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("");
        if (text) last = text;
        for (const block of blocks) {
          if (block?.type !== "tool_use") continue;
          emit({ type: "tool", name: String(block.name), ...(typeof block.input?.file_path === "string" ? { path: block.input.file_path } : {}) });
          if (block.name === "Grep" || block.name === "Glob") lookups.set(block.id, typeof block.input?.path === "string" ? block.input.path : "");
        }
      } else if (m.type === "user") {
        for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (block?.type !== "tool_result" || block.is_error || !lookups.has(block.tool_use_id)) continue;
          const text: string = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part: any) => String(part?.text ?? "")).join("\n") : "";
          if (!text.trim() || /^No (files|matches) found/.test(text)) continue;
          // a Grep inside one file prints "line:text" with no path, so its scope counts too
          const paths = text.split(/\r?\n/).map((line) => line.replace(/^((?:[a-zA-Z]:)?[^:]*).*$/, "$1")).filter(Boolean);
          emit({ type: "found", paths: [lookups.get(block.tool_use_id)!, ...paths].filter(Boolean) });
        }
      } else if (m.type === "result") {
        finish(!m.is_error, typeof m.result === "string" ? m.result : last, usage(m.usage));
      }
    };
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.resume();
    child.on("error", () => finish(false, ""));
    child.on("close", () => finish(false, last));
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [input.live, input.text].filter(Boolean).join("\n\n") } }) + "\n");

    let closing: Promise<void> | null = null;
    return {
      live,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: (graceMs = 0) =>
        (closing ??= (async () => {
          child.stdin.end();
          if (child.exitCode === null && child.signalCode === null) {
            const timer = setTimeout(() => killCliTree(child), graceMs);
            await exited;
            clearTimeout(timer);
          }
          rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        })()),
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
