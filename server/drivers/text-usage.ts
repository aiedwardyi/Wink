import type { UsageObserver } from "../turn-timing.ts";

function totalTokens(...counts: unknown[]): number | undefined {
  if (!counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  const total = (counts as number[]).reduce((sum, n) => sum + n, 0);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

export function claudeText(stdout: string, onUsage: UsageObserver): string {
  const result = JSON.parse(stdout);
  if (result.is_error || typeof result.result !== "string") throw new Error("Claude text generation failed");
  const usage = result.usage;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const cachedInput = usage?.cache_read_input_tokens ?? 0;
  const input = usage ? totalTokens(usage.input_tokens, cacheCreation, cachedInput) : undefined;
  if (input !== undefined && totalTokens(input, usage.output_tokens) !== undefined) onUsage({ input, output: usage.output_tokens, cachedInput, cacheCreation });
  return result.result.trim();
}

export function codexTextUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): Parameters<UsageObserver>[0] {
  return usage && totalTokens(usage.inputTokens, usage.outputTokens) !== undefined ? { input: usage.inputTokens!, output: usage.outputTokens! } : undefined;
}

export const usageTokens = (usage: Parameters<UsageObserver>[0]): number | undefined => usage && totalTokens(usage.input, usage.output);
