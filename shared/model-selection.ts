import type { ModelSelection } from "../server/contracts.ts";

// Explicit, never an allowlist: unknown kinds keep their old behavior.
const RETIRED_ENGINE_KINDS = new Map([
  ["grok", "Grok (API)"], ["geminiAgent", "Gemini API"], ["kimiAgent", "Kimi"], ["droidAgent", "Droid"],
  ["cursorAgent", "Cursor"], ["qwenAgent", "Qwen"], ["hermesAgent", "Hermes"],
  ["openai-compat", "OpenAI-compatible (OpenRouter / Groq)"], ["piAgent", "pi"],
  ["minimax", "MiniMax (API)"], ["opencodeGo", "OpenCode"],
]);

/** Never offered, but bots saved on them still run and the Model Index still charts them. */
export const RETIRED_PICKER_MODEL_IDS: readonly string[] = ["claude-fable-5"];

/** Gemini Flash ids dropped from the catalog; saved bots move to 3.8 Flash at the same effort. */
export const RETIRED_GEMINI_FLASH_IDS: readonly (readonly [from: string, to: string])[] = ["3.7", "3.6", "3.5"].flatMap((version) =>
  ["high", "medium", "low"].map((effort) => [`gemini-${version}-flash-${effort}`, `gemini-3.8-flash-${effort}`] as const),
);

export function isRetiredEngineKind(kind?: string): boolean {
  return kind !== undefined && RETIRED_ENGINE_KINDS.has(kind);
}

export function retiredEngineLabel(kind: string): string | undefined {
  return RETIRED_ENGINE_KINDS.get(kind);
}

export function sameModelSelection(a: ModelSelection, b: ModelSelection): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.model === b.model &&
    (a.mode ?? "pinned") === (b.mode ?? "pinned") &&
    a.effort === b.effort
  );
}
