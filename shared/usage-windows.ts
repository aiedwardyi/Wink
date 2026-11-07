import type { RateLimitWindow } from "../server/contracts.ts";

export type WindowKind = "session" | "weekly" | "other";
export type UsageEvidence = { windows: readonly RateLimitWindow[]; observedAt: string };
const CODEX_BUCKET_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
const CLAUDE_FAMILIES = new Map([
  ["opus", "opus"], ["sonnet", "sonnet"], ["haiku", "haiku"],
  ["claude-opus-5-5", "opus"], ["claude-sonnet-5-5", "sonnet"], ["claude-haiku-5-5", "haiku"],
  ["claude-sonnet-4-6", "sonnet"], ["claude-opus-4-6-thinking", "opus"],
]);

export function windowKind(window: Pick<RateLimitWindow, "id" | "windowMinutes">): WindowKind {
  const id = window.id.split(":").at(-1)!;
  if (id.startsWith("seven_day") || (window.windowMinutes ?? 0) >= 10080) return "weekly";
  if (id === "five_hour" || window.windowMinutes === 300) return "session";
  return "other";
}

export function usageEngine(model: string): string {
  if (/^(claude-|opus|sonnet|haiku)/i.test(model)) return "claudeAgent";
  if (model.startsWith("gpt-")) return "codex";
  if (model.startsWith("grok-")) return "grokAgent";
  if (model.startsWith("gemini-")) return "antigravityAgent";
  if (model.startsWith("muse-")) return "museAgent";
  return "unknown";
}

function codexScope(bucket: string): string | null {
  if (bucket === "spark") return "gpt-5.3-codex-spark";
  if (CODEX_BUCKET_MODELS.has(bucket)) return bucket;
  return null;
}

export function windowScopeKnown(engine: string, window: RateLimitWindow): boolean {
  if (engine === "claudeAgent" || engine === "claude") return /^(five_hour|seven_day|seven_day_opus|seven_day_sonnet)$/.test(window.id);
  if (engine === "codex" && window.id.includes(":")) {
    const bucket = window.id.split(":")[0];
    return bucket === "codex" || codexScope(bucket) !== null;
  }
  return true;
}

export function applicableWindows<T extends Pick<RateLimitWindow, "id">>(engine: string, model: string, windows: readonly T[]): T[] {
  return windows.filter((window) => {
    if (engine === "claudeAgent" || engine === "claude") {
      const family = CLAUDE_FAMILIES.get(model);
      if (window.id === "seven_day_opus" && (family === "sonnet" || family === "haiku")) return false;
      if (window.id === "seven_day_sonnet" && (family === "opus" || family === "haiku")) return false;
    }
    if (engine === "codex" && window.id.includes(":")) {
      const scope = codexScope(window.id.split(":")[0]);
      if (scope && model && scope !== model) return false;
    }
    return true;
  });
}

export function workerWindowLow(window: RateLimitWindow): boolean {
  return Number.isFinite(window.usedPercent) && window.usedPercent >= 0
    && 100 - window.usedPercent < (windowKind(window) === "weekly" ? 10 : 25);
}

export function assessUsage(engine: string, model: string, evidence: UsageEvidence | undefined, now: number, prior?: UsageEvidence): "low" | "unknown" | "ready" {
  const windows = applicableWindows(engine, model, evidence?.windows ?? []);
  const previous = applicableWindows(engine, model, prior?.windows ?? []).filter(workerWindowLow);
  if (windows.some(workerWindowLow)) return "low";
  const observed = Date.parse(evidence?.observedAt ?? "");
  const fresh = Number.isFinite(observed) && observed <= now && now - observed <= 5 * 60_000;
  const clears = fresh && observed > Date.parse(prior?.observedAt ?? "") && previous.every((old) => windows.some((window) =>
    window.id === old.id && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && !workerWindowLow(window)));
  if (previous.length && !clears) return "low";
  if (!fresh || !windows.length || windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || !windowScopeKnown(engine, window))) return "unknown";
  return "ready";
}
