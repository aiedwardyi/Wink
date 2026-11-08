// Usage left for the engine a terminal_spawn launches, and a hold on a nearly empty window.
import type { RateLimitWindow } from "./contracts.ts";
import { applicableWindows, usageEngine, windowKind, workerWindowLow } from "../shared/usage-windows.ts";
import type { RateLimitsMap, RateLimitsReport } from "./rate-limits-store.ts";

type Engine = { name: string; instanceId: string };
type SpawnUsage = { hold?: string; line?: string };
export type SpawnAccount = { readonly id: string; readonly generation: number; readonly name: string };

// First words of the terminal_spawn templates, each with its engine's default instance.
const ENGINES = new Map<string, Engine>([
  ["claude", { name: "Claude", instanceId: "claude" }],
  ["codex", { name: "Codex", instanceId: "codex" }],
  ["grok", { name: "Grok", instanceId: "grok" }],
  ["agy", { name: "Gemini", instanceId: "antigravity" }],
  ["muse", { name: "Muse", instanceId: "muse" }],
]);
const ENGINE_KINDS = new Map([["Claude", "claudeAgent"], ["Codex", "codex"], ["Grok", "grokAgent"], ["Gemini", "antigravityAgent"], ["Muse", "museAgent"]]);
// The Gemini template on Windows leads with `$env:NAME='value'; `.
const ENV_STATEMENT = /^\s*\$env:(\w+)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s;]+)\s*;/i;
// Each one points the CLI at another account than the default instance reads.
const OTHER_HOME = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);
const STALE_MS = 5 * 60_000;
const REFRESH_CAP_MS = 3_000;
const REPEAT_MS = 2 * 60_000;
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function spawnEngine(command: string): Engine | null {
  let rest = command;
  for (let statement = ENV_STATEMENT.exec(rest); statement; statement = ENV_STATEMENT.exec(rest)) {
    if (OTHER_HOME.has(statement[1].toUpperCase())) return null;
    rest = rest.slice(statement[0].length);
  }
  return ENGINES.get(rest.trimStart().split(/\s/, 1)[0]) ?? null;
}

// Whole percent left, as the usage bars show it.
const left = (window: RateLimitWindow) => Math.max(0, 100 - Math.max(0, Math.round(window.usedPercent)));

function settleWithin(pending: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    pending.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

type Deps = {
  rateLimits: RateLimitsMap;
  save: (id: string, report: RateLimitsReport) => void;
  refresh: (instanceId: string, previous: RateLimitsReport | undefined) => Promise<{ report?: RateLimitsReport }>;
  environment: (instanceId: string) => Record<string, string> | undefined;
  nameOf?: (id: string, engine: string) => string;
  now?: () => number;
};

export function createSpawnUsage(deps: Deps) {
  const now = deps.now ?? Date.now;
  const held = new Map<string, { at: number; instanceId: string }>();
  const refreshed = async (instanceId: string) => {
    const result = await deps.refresh(instanceId, deps.rateLimits.get(instanceId));
    const current = deps.rateLimits.get(instanceId);
    const observed = Date.parse(result.report?.observedAt ?? "");
    if (result.report && observed <= now() && (!current || observed >= Date.parse(current.observedAt))) {
      const incoming = result.report;
      const fresh = now() - observed <= STALE_MS;
      const retained = (current?.windows ?? []).filter((old) => workerWindowLow(old) && (!fresh || !incoming.windows.some((window) => window.id === old.id && Number.isFinite(window.usedPercent) && window.usedPercent >= 0)));
      const next = retained.length ? { ...incoming, windows: [...incoming.windows.filter((window) => !retained.some((old) => old.id === window.id)), ...retained] } : incoming;
      deps.rateLimits.set(instanceId, next);
      deps.save(instanceId, next);
    }
  };
  const usage = async (botId: string, label: string, command: string, account?: SpawnAccount, recovery = false): Promise<SpawnUsage> => {
    const engine = account ? { name: account.name, instanceId: account.id } : spawnEngine(command);
    // Legacy panes do not inherit the instance's account environment.
    if (!engine || (!account && Object.keys(deps.environment(engine.instanceId) ?? {}).some((name) => OTHER_HOME.has(name.toUpperCase())))) return {};
    const report = deps.rateLimits.get(engine.instanceId);
    if (!report || !(now() - Date.parse(report.observedAt) <= STALE_MS)) await settleWithin(refreshed(engine.instanceId), REFRESH_CAP_MS);
    const at = now();
    const model = /(?:^|\s)(?:--model|-m)\s+["']?([a-zA-Z0-9._-]+)/.exec(command)?.[1] ?? "";
    const kind = usageEngine(model) === "unknown" ? ENGINE_KINDS.get(engine.name) ?? "unknown" : usageEngine(model);
    const live = applicableWindows(kind, model, deps.rateLimits.get(engine.instanceId)?.windows ?? []).filter((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0);
    if (!live.length) return {};
    const text = (suffix: string) => live.map((window) => {
      const type = windowKind(window);
      const label = window.id === "five_hour" ? "5h" : window.id === "seven_day" ? "weekly" : window.id;
      const reset = type === "session" && window.resetsAt !== null && Number.isFinite(window.resetsAt) ? ` (resets ${CLOCK.format(window.resetsAt)})` : "";
      return `${label} ${left(window)}%${suffix}${reset}`;
    }).join(", ");
    const name = deps.nameOf?.(engine.instanceId, engine.name) ?? engine.name;
    for (const [key, heldAt] of held) if (at - heldAt.at > REPEAT_MS) held.delete(key);
    const key = JSON.stringify(account ? [botId, label, command, account.id, account.generation] : [botId, label, command]);
    if (live.some(workerWindowLow) && (recovery || !held.has(key))) {
      if (!recovery) held.set(key, { at, instanceId: engine.instanceId });
      return { hold: `Held: ${name} ${text(" left")}. Pick another engine, or send the same spawn again within 2 min to launch anyway.` };
    }
    if (!recovery) held.delete(key);
    return { line: `${name} usage left: ${text("")}.` };
  };
  return Object.assign(usage, { refresh: refreshed, invalidate: (instanceId: string) => {
    for (const [key, hold] of held) if (hold.instanceId === instanceId) held.delete(key);
  } });
}
