import type { AccountService } from "./accounts.ts";
import { AccountLifecycle } from "./account-lifecycle.ts";
import { BotAccounts } from "./bot-accounts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { ProviderReload } from "./harness/provider-reload.ts";
import type { Store } from "./store.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";
import type { createUsageRefresh } from "./usage-refresh.ts";
import { terminalPaneCountsResponse, type TerminalBridgeAccess } from "./terminal-snapshot.ts";

export function createAccountRuntime(deps: {
  accounts: AccountService; registry: ProviderRegistry; providers: ProviderReload; store: Store;
  reload(): Promise<void>; rateLimits: RateLimitsMap; saveRateLimits(): void;
  usage: ReturnType<typeof createUsageRefresh>; availability: Map<string, boolean>;
  invalidateHolds(id: string): void; invalidateWaits(id: string): void;
  botActive(id: string): boolean; terminal(): TerminalBridgeAccess | null; configBusy(): boolean;
  bots?: BotAccounts;
}) {
  const bots = deps.bots ?? new BotAccounts(deps.accounts, deps.registry, deps.store, {
    active: deps.botActive, captured: (threadId) => deps.providers.current(threadId),
  });
  return new AccountLifecycle(deps.accounts, deps.registry, {
    reload: deps.reload,
    configBusy: deps.configBusy,
    panesBusy: () => accountPanesBusy(deps.terminal()),
    referenced: async (id, activeOnly) => {
      if (deps.providers.inUse(id) || deps.registry.accountBusy(id) || deps.usage.busy(id)) return true;
      for (const bot of deps.store.bots) {
        const selected = bots.references(bot, id);
        if (selected && (!activeOnly || deps.botActive(bot.id))) return true;
        if ((bot.tasks ?? []).some((task) => deps.registry.get(id)?.adapter.hasSession(task.threadId) || deps.registry.get(id)?.adapter.hasBackgroundWork?.(task.threadId))) return true;
      }
      return activeOnly ? false : accountPanesBusy(deps.terminal());
    },
    invalidate: (id) => {
      deps.registry.invalidateAccount(id);
      deps.usage.invalidate(id);
      deps.rateLimits.delete(id);
      deps.saveRateLimits();
      deps.availability.delete(id);
      deps.invalidateHolds(id);
      deps.invalidateWaits(id);
      deps.store.clearAccountSessions(id);
    },
  }, bots);
}

export async function accountPanesBusy(terminal: TerminalBridgeAccess | null): Promise<boolean> {
  if (!terminal) return false;
  const panes = await terminalPaneCountsResponse(terminal);
  // Until panes capture an account, a live pane cannot prove it is unrelated.
  return panes.status !== 200 || !("counts" in panes.body) || Object.values(panes.body.counts).some((count) => count > 0);
}
