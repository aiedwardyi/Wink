// Grok Build harness support — the official `grok` CLI over ACP stdio
// (`grok … agent stdio`), on the grok.com subscription login
// (~/.grok/auth.json), NOT the xAI API key (that driver is drivers/grok.ts).
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks. Verified against grok 1.0.0.
import { lstatSync, readFileSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import type { ModelCatalog } from "../../contracts.ts";
import { writeFileAtomic } from "../../atomic.ts";
import { grokAgentsAllowState, saveGrokAgentsAllowState } from "../../grok-agents-allow-state.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "../local-inject.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { accountLabel, storedAccount, storedSignIn } from "../auth-status.ts";
import { createCliText, type CliTextRun } from "../cli-text.ts";

export const STATIC_GROK_MODELS: ModelCatalog = {
  default: "grok-4.6",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4.6", label: "Grok 4.6", contextWindow: 500_000 },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const grokAuthSchema = z.record(z.string(), z.object({ key: z.string().optional(), refresh_token: z.string().optional() }));
const grokAccountSchema = z.record(z.string(), z.object({
  key: z.string().optional(), refresh_token: z.string().optional(), email: z.unknown().optional(), first_name: z.unknown().optional(), last_name: z.unknown().optional(),
}));

function grokHome(env: Record<string, string | undefined>): string {
  if (env.GROK_HOME) return env.GROK_HOME;
  return join(env.HOME || env.USERPROFILE || homedir(), ".grok");
}

/** Probed at the same home the config is read from: on the real homedir a set
 *  GROK_HOME/HOME reads as signed in and the inline sign-in card never renders. */
export function grokIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return storedSignIn(join(grokHome(env), "auth.json"), (text) => {
    const parsed = grokAuthSchema.safeParse(JSON.parse(text));
    return parsed.success && Object.values(parsed.data).some((entry) => Boolean(entry.key?.trim() || entry.refresh_token?.trim()));
  });
}

/** Two signed-in entries naming different people leave the account unknown. */
export function grokAccount(env: Record<string, string | undefined>): string | undefined {
  return storedAccount(join(grokHome(env), "auth.json"), (auth) => {
    const parsed = grokAccountSchema.safeParse(auth);
    if (!parsed.success) return undefined;
    const labels = new Set(Object.values(parsed.data)
      .filter((entry) => entry.key?.trim() || entry.refresh_token?.trim())
      .map((entry) => accountLabel(entry.email, [entry.first_name, entry.last_name].filter((part) => typeof part === "string").join(" "))));
    return labels.size === 1 ? [...labels][0] : undefined;
  });
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/** Local slugs from ~/.grok/config.toml, plus the two cloud defaults.
 *  `grok -m <slug>` already accepts these; the picker just didn't list them. */
export function readGrokModelCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog {
  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return STATIC_GROK_MODELS;
  }

  const options = STATIC_GROK_MODELS.options.map((o) => ({ ...o }));
  const seen = new Set(options.map((o) => o.id));
  let configuredDefault: string | null = null;
  let current: { slug: string; name?: string } | null = null;
  let inModels = false;

  const flush = () => {
    if (!current || !SLUG.test(current.slug) || seen.has(current.slug)) {
      current = null;
      return;
    }
    seen.add(current.slug);
    options.push({ id: current.slug, label: current.name || current.slug, custom: true });
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped === "[models]") {
      flush();
      inModels = true;
      continue;
    }
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      inModels = false;
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      inModels = false;
      continue;
    }
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (current && key === "name" && value) current.name = value;
    if (!current && inModels && key === "default") configuredDefault = value;
  }
  flush();

  return {
    default: configuredDefault && seen.has(configuredDefault) ? configuredDefault : STATIC_GROK_MODELS.default,
    options,
  };
}

function suggestGrokSlug(host: string, model: string, taken: Set<string>): string {
  let base = `${host}-${model}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = `m-${base || "model"}`;
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a [model.slug] block so `grok -m` can reach the injected host. */
export function ensureGrokInjectSlug(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inject = decodeInjectId(modelId);
  if (!inject) return modelId;
  const host = localHost(inject.host);
  if (!host) return modelId;

  const path = join(grokHome(env), "config.toml");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const taken = new Set<string>(STATIC_GROK_MODELS.options.map((option) => option.id));
  let current: { slug: string; model?: string; baseUrl?: string } | null = null;
  const flush = () => {
    if (!current) return;
    taken.add(current.slug);
    if (current.model === inject.model && current.baseUrl === host.baseUrl) {
      found = current.slug;
    }
    current = null;
  };
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("[model.") && stripped.endsWith("]")) {
      flush();
      let inner = stripped.slice("[model.".length, -1);
      if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
      current = { slug: inner };
      continue;
    }
    if (stripped.startsWith("[")) {
      flush();
      continue;
    }
    if (!current || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const key = stripped.slice(0, eq).trim();
    const value = unquote(stripped.slice(eq + 1));
    if (key === "model") current.model = value;
    if (key === "base_url") current.baseUrl = value;
  }
  flush();
  if (found) return found;

  const slug = suggestGrokSlug(inject.host, inject.model, taken);
  const heading = /[^a-z0-9_-]/i.test(slug) ? `[model."${slug}"]` : `[model.${slug}]`;
  const block = [
    heading,
    `model = ${quoteToml(inject.model)}`,
    `base_url = ${quoteToml(host.baseUrl)}`,
    `name = ${quoteToml(`${inject.model} (${host.label})`)}`,
    `api_backend = "chat_completions"`,
    `api_key = ${quoteToml(hostApiKey(host, env))}`,
    "",
  ].join("\n");
  const next = text && !text.endsWith("\n") ? `${text}\n\n${block}` : `${text}${text ? "\n" : ""}${block}`;
  writeFileSync(path, next, { mode: 0o600 });
  return slug;
}

const AGENTS_ALLOW = "MCPTool(agents__*)";

type TomlNode = { start: number; end: number } & (
  | { kind: "string"; value: string }
  | { kind: "array"; items: TomlNode[] }
  | { kind: "table"; entries: Record<string, TomlNode> }
  | { kind: "scalar" }
);

/** Headers and key/values of a TOML file with their offsets. Throws on anything outside the TOML it knows. */
function scanToml(text: string) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (): never => { throw new Error(`config.toml: cannot read offset ${i}`); };
  const space = () => { while (text[i] === " " || text[i] === "\t") i++; };
  const comment = () => { if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++; };
  const gap = () => {
    for (;;) {
      space();
      comment();
      if (text.startsWith("\r\n", i)) i += 2;
      else if (text[i] === "\n") i++;
      else return;
    }
  };
  const lineEnd = () => {
    space();
    comment();
    if (text.startsWith("\r\n", i)) i += 2;
    else if (text[i] === "\n") i++;
    else if (i < text.length) fail();
  };
  const str = (): string => {
    const q = text[i];
    const fence = text.startsWith(q.repeat(3), i) ? q.repeat(3) : q;
    i += fence.length;
    let out = "";
    for (;;) {
      if (i >= text.length || (fence.length === 1 && text[i] === "\n")) fail();
      if (text.startsWith(fence, i)) { i += fence.length; return out; }
      if (q === '"' && text[i] === "\\") { out += text.slice(i, i + 2); i += 2; continue; }
      out += text[i++];
    }
  };
  const bare = /[A-Za-z0-9_-]+/y;
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      space();
      if ((text[i] === '"' || text[i] === "'") && !text.startsWith(text[i].repeat(3), i)) {
        const at = i;
        parts.push(str());
        if (text.slice(at, i).includes("\\")) fail();
      } else {
        bare.lastIndex = i;
        const m = bare.exec(text) ?? fail();
        i = bare.lastIndex;
        parts.push(m[0]);
      }
      space();
      if (text[i] !== ".") return parts;
      i++;
    }
  };
  const scalar = /[0-9A-Za-z_+.:-]+(?: \d\d:[0-9:.+Z-]+)?/y;
  const value = (): TomlNode => {
    const start = i;
    if (text[i] === '"' || text[i] === "'") return { kind: "string", value: str(), start, end: i };
    if (text[i] === "[") {
      i++;
      const items: TomlNode[] = [];
      for (gap(); text[i] !== "]"; gap()) {
        items.push(value());
        gap();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail();
      }
      i++;
      return { kind: "array", items, start, end: i };
    }
    if (text[i] === "{") {
      i++;
      const entries: Record<string, TomlNode> = Object.create(null);
      for (space(); text[i] !== "}"; space()) {
        const k = key().join(".");
        if (text[i] !== "=") fail();
        i++;
        space();
        entries[k] = value();
        space();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail();
      }
      i++;
      return { kind: "table", entries, start, end: i };
    }
    scalar.lastIndex = i;
    if (!scalar.exec(text)) fail();
    i = scalar.lastIndex;
    return { kind: "scalar", start, end: i };
  };

  const headers: Array<{ path: string[]; array: boolean; next: number }> = [];
  const values: Array<{ path: string[]; node: TomlNode }> = [];
  let table: string[] = [];
  for (gap(); i < text.length; gap()) {
    if (text[i] === "[") {
      const array = text[i + 1] === "[";
      i += array ? 2 : 1;
      table = key();
      if (!text.startsWith(array ? "]]" : "]", i)) fail();
      i += array ? 2 : 1;
      lineEnd();
      headers.push({ path: table, array, next: i });
      continue;
    }
    const path = [...table, ...key()];
    if (text[i] !== "=") fail();
    i++;
    space();
    values.push({ path, node: value() });
    lineEnd();
  }
  return { headers, values };
}

/** Could this rule (`MCPTool(x)`, `mcp__x`, `*`) match any tool on the `agents` server? */
function ruleReachesAgents(rule: string, structured = false): boolean {
  const r = rule.trim();
  if (r === "*" || r === "MCPTool") return true;
  let pattern = structured ? r : /^MCPTool\((.*)\)$/.exec(r)?.[1];
  if (!structured && pattern === undefined && r.startsWith("mcp__")) {
    pattern = r.slice("mcp__".length);
    if (!pattern.includes("__") && !pattern.includes("*")) pattern += "__*";
  }
  if (pattern === undefined) return false;
  pattern = pattern.trim();
  const glob = pattern.search(/[*?[]/);
  if (glob < 0) return pattern.startsWith("agents__");
  const prefix = pattern.slice(0, glob);
  return "agents__".startsWith(prefix) || prefix.startsWith("agents__");
}

function entryReachesAgents(node: TomlNode): boolean {
  if (node.kind !== "table") return true;
  const field = (name: string) => {
    const hit = node.entries[name];
    return hit?.kind === "string" ? hit.value : hit ? null : undefined;
  };
  const action = field("action");
  const tool = field("tool");
  const pattern = field("pattern");
  if (action !== "deny" && action !== "ask") return false;
  if (tool === null || pattern === null) return true;
  if (tool !== undefined && tool.toLowerCase() !== "mcp") return false;
  return pattern === undefined || ruleReachesAgents(pattern, true);
}

/** The text with Wink's allow rule added, or null to leave the file alone (unreadable, or a user rule covers these tools). */
function withGrokAgentsAllowed(text: string): string | null {
  let doc: ReturnType<typeof scanToml>;
  try {
    doc = scanToml(text);
  } catch {
    return null;
  }
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const quoted = quoteToml(AGENTS_ALLOW);
  const perm = (name: string) => doc.values.find((v) => v.path.length === 2 && v.path[0] === "permission" && v.path[1] === name)?.node;
  if (doc.headers.some((h) => h.array && h.path[0] === "permission")) return null;
  if (doc.values.some((v) => v.path.length === 1 && v.path[0] === "permission")) return null;
  for (const name of ["deny", "ask"]) {
    const node = perm(name);
    if (node && (node.kind !== "array" || node.items.some((item) => item.kind !== "string" || ruleReachesAgents(item.value)))) return null;
  }
  const rules = perm("rules");
  if (rules && (rules.kind !== "array" || rules.items.some(entryReachesAgents))) return null;

  const allow = perm("allow");
  if (allow) {
    if (allow.kind !== "array") return null;
    if (allow.items.some((item) => item.kind === "string" && item.value === AGENTS_ALLOW)) return text;
    const last = allow.items.at(-1);
    if (!last) return `${text.slice(0, allow.start + 1)}${quoted}${text.slice(allow.start + 1)}`;
    const multiline = text.slice(allow.start, allow.end).includes("\n");
    const lineStart = text.lastIndexOf("\n", last.start) + 1;
    const indent = multiline ? /^[ \t]*/.exec(text.slice(lineStart))![0] : "";
    return `${text.slice(0, last.end)},${multiline ? nl + indent : " "}${quoted}${text.slice(last.end)}`;
  }
  const line = `allow = [${quoted}]${nl}`;
  const header = doc.headers.find((h) => !h.array && h.path.length === 1 && h.path[0] === "permission");
  if (header) {
    const at = header.next;
    return `${text.slice(0, at)}${text.slice(0, at).endsWith("\n") ? "" : nl}${line}${text.slice(at)}`;
  }
  if (doc.values.some((v) => v.path[0] === "permission")) return null;
  const lead = !text ? "" : text.endsWith("\n") ? nl : nl + nl;
  return `${text}${lead}[permission]${nl}${line}`;
}

/** Config stamps already checked, so a turn start costs one stat. */
const agentsAllowChecked = new Map<string, string>();
const configStat = (path: string) => {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};
const stampOf = (s: Stats | null) => (s ? `${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.mode}` : "missing");

/** Grok's agent stdio ignores argv `--allow` (1.0.77); only this file's rule spares each Wink tool call its ask. */
function ensureGrokAgentsAllowed(env: Record<string, string | undefined>): void {
  const path = resolve(grokHome(env), "config.toml");
  try {
    const saved = grokAgentsAllowState(path);
    if (saved === "written") return;
    const before = configStat(path);
    const stamp = stampOf(before);
    if (saved === stamp || agentsAllowChecked.get(path) === stamp) return;
    agentsAllowChecked.set(path, stamp);
    // a rename over a symlink would replace the user's linked config with a plain file
    const raw = before?.isSymbolicLink() ? null : before ? readFileSync(path) : Buffer.alloc(0);
    const text = raw?.toString("utf8") ?? "";
    const next = raw && Buffer.from(text, "utf8").equals(raw) ? withGrokAgentsAllowed(text) : null;
    if (next !== null && next !== text && stampOf(configStat(path)) === stamp) {
      // Persist the intent first so a crash cannot restore a rule the user later removes.
      saveGrokAgentsAllowState(path, "written");
      try {
        writeFileAtomic(path, next, { mode: before ? before.mode & 0o777 : 0o600 });
      } catch {
        saveGrokAgentsAllowState(path, stamp);
      }
    }
    agentsAllowChecked.set(path, stampOf(configStat(path)));
  } catch {
    /* left alone: Grok keeps asking, as before */
  }
}

/** Candidate spellings for the reasoning-effort config option, most
 * specific first. LIVE-verified primary first: the grok CLI advertises
 * {id: "reasoning_effort", name: "Reasoning Effort"}; the rest keep
 * discovery working across CLI renames. */
const EFFORT_CONFIG_CANDIDATES = ["reasoning_effort", "reasoningEffort", "reasoning-effort", "reasoning", "effort"];

const normalizeConfigToken = (value: unknown): string => String(value ?? "").toLowerCase().replace(/[-_\s]/g, "");

/** Find the reasoning-effort option id in a session/new (or load) result's
 * configOptions. Discovery, not a hardcoded id: the CLI names it, we match
 * the effort vocabulary. Returns null when nothing advertises it. */
export function findGrokEffortConfigId(sessionResult: unknown): string | null {
  const options = (sessionResult as { configOptions?: unknown } | null | undefined)?.configOptions;
  if (!Array.isArray(options)) return null;
  for (const candidate of EFFORT_CONFIG_CANDIDATES) {
    const want = normalizeConfigToken(candidate);
    for (const option of options) {
      if (!option || typeof option !== "object") continue;
      const { id, name } = option as { id?: unknown; name?: unknown };
      if (typeof id !== "string" || !id) continue;
      if (normalizeConfigToken(id) === want || normalizeConfigToken(name) === want) return id;
    }
  }
  return null;
}

/** currentValue of one config option in a set_config_option result. */
export function configOptionValue(result: unknown, configId: string): unknown {
  const options = (result as { configOptions?: unknown } | null | undefined)?.configOptions;
  if (!Array.isArray(options)) return null;
  const hit = options.find(
    (option): option is { id: string; currentValue?: unknown } =>
      !!option && typeof option === "object" && (option as { id?: unknown }).id === configId,
  );
  return hit?.currentValue ?? null;
}

/** SHA-256 of auth.json, cached by path+file identity+mtime+size so sendTurn hot path
 * stats instead of sync-reading+hashing on every turn. */
type AuthHashCache = { dev: number; ino: number; mtimeMs: number; size: number; hash: string };
const authHashByPath = new Map<string, AuthHashCache>();

export function hashGrokAuthJson(path: string): string {
  const before = statSync(path);
  const cached = authHashByPath.get(path);
  if (
    cached
    && cached.dev === before.dev
    && cached.ino === before.ino
    && cached.mtimeMs === before.mtimeMs
    && cached.size === before.size
  ) {
    return cached.hash;
  }
  // Read once into a buffer, then re-stat. Only cache when metadata still
  // matches the bytes we hashed — closes the stat→read TOCTOU where an
  // atomic replace with same size in the same mtime tick could otherwise
  // store a new digest under the old key.
  const buf = readFileSync(path);
  const hash = createHash("sha256").update(buf).digest("hex");
  const after = statSync(path);
  if (
    after.dev === before.dev
    && after.ino === before.ino
    && after.mtimeMs === before.mtimeMs
    && after.size === before.size
    && after.size === buf.length
  ) {
    authHashByPath.set(path, { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, size: after.size, hash });
  }
  return hash;
}

/** Test-only: drop cached auth hashes (per-path or all). */
export function clearGrokAuthHashCache(path?: string): void {
  if (path) authHashByPath.delete(path);
  else authHashByPath.clear();
}

const GROK_TEXT_MODEL = "grok-4.6";
const GROK_TEXT_TIMEOUT_MS = 90_000;

const grokTextSchema = z.object({ text: z.string(), stopReason: z.string(), cwd: z.string().optional() });

function parseGrokText(stdout: string): string {
  const result = grokTextSchema.parse(JSON.parse(stdout));
  if (result.stopReason !== "end_turn" || !result.text.trim()) throw new Error("Grok text returned no text");
  return result.text.trim();
}

/** grok -p always saves a session under the folder it ran in. */
function removeGrokTextSession({ cwd, stdout, env }: CliTextRun): void {
  const dirs = new Set([cwd]);
  try {
    const reported = grokTextSchema.parse(JSON.parse(stdout)).cwd;
    if (reported && resolve(reported).toLowerCase() === resolve(cwd).toLowerCase()) dirs.add(reported);
  } catch { /* killed before output */ }
  for (const dir of dirs) rmSync(join(grokHome(env), "sessions", encodeURIComponent(dir)), { recursive: true, force: true });
}

const GROK_COMPACTION_UPDATES = new Set(["auto_compact_started", "compaction_checkpoint", "auto_compact_completed"]);

export const grokSupport: AcpSupport = {
  driverKind: "grokAgent",
  grokInterjections: true,
  warmSessionIdentity: (env) => {
    try {
      return hashGrokAuthJson(join(grokHome(env), "auth.json"));
    } catch { return null; }
  },
  rateLimits: true,
  billingMethod: "_x.ai/billing",
  displayName: "Grok",
  images: false,
  models: STATIC_GROK_MODELS,
  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
  // Grok's accepted levels vary by model (LIVE-verified CLI 1.0.41): 4.6/4.7
  // take low–xhigh, 4.5 takes low–high and rejects xhigh/max. The declared
  // list is the union; the per-model gate in shared/model-effort.ts
  // (isEffortOffered/offeredEffortLevels) enforces eligibility at every
  // offer and validation site, so 4.5 is never offered xhigh.
  effortLevels: ["low", "medium", "high", "xhigh"],
  defaultCli: "grok",
  nativeSource: "grok.acp",
  loginNote: "Grok CLI is not signed in — run `grok login` in a terminal",

  // Official one-liners: POSIX curl|bash on macOS/Linux, PowerShell irm|iex
  // on Windows (https://x.ai/cli/install.ps1 usage header).
  install: {
    command: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
      win32: "irm https://x.ai/cli/install.ps1 | iex",
    },
    docsUrl: "https://x.ai/cli",
    signInCommand: "grok login",
    login: { args: ["login"], deviceArgs: ["login", "--device-auth"], authHosts: ["accounts.x.ai"] },
    logout: ["logout"],
  },

  // Write the [model.slug] block with the instance HOME/GROK_HOME, then pass
  // the slug on argv. spawnArgs must not call ensureGrokInjectSlug itself —
  // that helper defaults to process.env and would miss the instance override.
  resolveTurnModel: (model, env, config) => {
    if (!config.fullAuto) ensureGrokAgentsAllowed(env);
    return model ? ensureGrokInjectSlug(model, env) : model;
  },

  // --permission-mode is a global grok flag. -m and --reasoning-effort are
  // agent flags: Grok 1.0.6 only applies them when they sit AFTER `agent`
  // and BEFORE `stdio` (`grok agent -m slug stdio`). Putting -m first is
  // accepted as a TUI option and then ignored, so ACP session/new keeps
  // [models].default (grok-4.6) and oMLX never sees a request.
  spawnArgs: (config, turn) => [
    "--permission-mode",
    config.fullAuto ? "bypassPermissions" : "default",
    "agent",
    ...(turn.model ? ["-m", turn.model] : []),
    // long form on purpose: `--effort` is documented as an alias, and an
    // alias is the part a CLI is free to rename
    ...(turn.effort ? ["--reasoning-effort", turn.effort] : []),
    "stdio",
  ],

  // argv -m pins the model on current grok; set_model is the fallback when session/new reports something else.
  async configureSession({ request, sessionId, turn, sessionResult }) {
    if (turn.model && configOptionValue(sessionResult, "model") !== turn.model) {
      try {
        await request("session/set_model", { sessionId, modelId: turn.model });
      } catch (e) {
        throw new Error(
          `Grok rejected model "${turn.model}" via session/set_model: ${(e as Error).message}. ` +
            `Check that grok is current (1.0.6+ supports it) and that this slug exists in ~/.grok/config.toml.`,
        );
      }
    }
    if (!turn.effort) return;
    const configId = findGrokEffortConfigId(sessionResult);
    if (!configId) {
      throw new Error(
        `Grok advertises no reasoning-effort setting, so effort "${turn.effort}" cannot be applied. ` +
          `Check that grok is current (1.0.30+ supports it).`,
      );
    }
    let applied: unknown;
    try {
      applied = await request("session/set_config_option", { sessionId, configId, value: turn.effort });
    } catch (e) {
      throw new Error(
        `Grok rejected reasoning effort "${turn.effort}" via session/set_config_option: ${(e as Error).message}. ` +
          `Check that grok is current (1.0.30+ supports it).`,
      );
    }
    // An agent that answers OK but keeps its old effort burns a paid turn on
    // the wrong setting — worse than erroring. Verify it stuck.
    const current = configOptionValue(applied, configId);
    if (current !== turn.effort) {
      throw new Error(
        `Grok did not switch reasoning effort to "${turn.effort}" (still ${current ?? "unknown"}). ` +
          `Check that grok is current (1.0.30+ supports it).`,
      );
    }
  },

  // The CLI owns its own grok.com login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.XAI_API_KEY;
  },

  // Bind the grok.com subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cached_token") ? "cached_token" : null),
  authFailure: "fail",
  isAuthenticated: grokIsAuthenticated,
  account: grokAccount,

  // `--append-system-prompt`/`--rules` are accepted by the CLI but do NOT
  // reach the agent-stdio system prompt (verified against 1.0.0), so the
  // persona is prepended codex-style.
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
  // Auto-compaction arrives as `_x.ai/session/update` (session records,
  // grok 1.0.46); the agent-mode docs also name `x.ai/session_notification`.
  compacted: (msg) => GROK_COMPACTION_UPDATES.has(msg.params?.update?.sessionUpdate),
  promptReport: (result, modelState, selectedModel) => {
    const input = result?._meta?.inputTokens;
    if (!Number.isSafeInteger(input) || input < 0) return undefined;
    const model = result?._meta?.modelId ?? selectedModel ?? modelState?.currentModelId;
    const models = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
    const window = models.find((entry: any) => entry?.modelId === model)?._meta?.totalContextTokens;
    return {
      prompt: { first: input, last: input },
      ...(Number.isSafeInteger(window) && window > 0 ? { contextWindow: window } : {}),
    };
  },
  text: ({ cli, env }) => createCliText({
    name: "Grok",
    model: GROK_TEXT_MODEL,
    timeoutMs: GROK_TEXT_TIMEOUT_MS,
    command: async (promptFile) => ({
      cli: await cli(),
      args: [
        "--prompt-file", promptFile, "--output-format", "json", "--verbatim",
        "-m", GROK_TEXT_MODEL, "--reasoning-effort", "low",
        "--max-turns", "1", "--disable-web-search", "--no-subagents", "--no-plan",
      ],
      env: { ...env(), GROK_MEMORY: "0" },
    }),
    parse: parseGrokText,
    cleanup: removeGrokTextSession,
  }),
};

export const GrokAgentDriver = createAcpDriver(grokSupport);
