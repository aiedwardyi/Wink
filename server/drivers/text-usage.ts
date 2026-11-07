function totalTokens(...counts: unknown[]): number | undefined {
  if (!counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  const total = (counts as number[]).reduce((sum, n) => sum + n, 0);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

export function claudeText(stdout: string, onUsage: (tokens: number) => void): string {
  const result = JSON.parse(stdout);
  if (result.is_error || typeof result.result !== "string") throw new Error("Claude text generation failed");
  const usage = result.usage;
  const tokens = usage ? totalTokens(usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0, usage.output_tokens) : undefined;
  if (tokens !== undefined) onUsage(tokens);
  return result.result.trim();
}

export function codexTextTokens(usage: { inputTokens?: number; outputTokens?: number } | undefined): number | undefined {
  return usage ? totalTokens(usage.inputTokens, usage.outputTokens) : undefined;
}
