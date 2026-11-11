import type { UsageBoardAccount, UsageBoardEngine } from "@/lib/usage-board";

export const USAGE_LAYOUT: "A" | "B" = "B";

export function usageAccounts(engine: UsageBoardEngine): UsageBoardAccount[] {
  return engine.accounts.filter((account) => !account.credit && (engine.engine !== "gemini" || account.windows.length > 0));
}
