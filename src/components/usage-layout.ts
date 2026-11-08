import type { UsageBoardAccount, UsageBoardEngine } from "@/lib/usage-board";

export const USAGE_LAYOUT: "A" | "B" = "B";

export function usageAccounts(engine: UsageBoardEngine): UsageBoardAccount[] {
  return engine.engine === "gemini" ? engine.accounts.filter((account) => account.windows.length > 0) : engine.accounts;
}
