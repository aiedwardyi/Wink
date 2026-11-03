import type { AccountService } from "./accounts.ts";
import { AccountLifecycle } from "./account-lifecycle.ts";
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
}) {
  return new AccountLifecycle(deps.accounts, deps.registry, {
    reload: deps.reload,
    configBusy: deps.configBusy,
    referenced: async (id, activeOnly) => {
      if (deps.providers.inUse(id) || deps.registry.get(id)?.accountBusy?.()) return true;
      for (const bot of deps.store.bots) {
        const selected = bot.modelSelection.instanceId === id || bot.pendingModelSelection?.instanceId === id;
        if (selected && (!activeOnly || deps.botActive(bot.id))) return true;
        if ((bot.tasks ?? []).some((task) => deps.registry.get(id)?.adapter.hasSession(task.threadId) || deps.registry.get(id)?.adapter.hasBackgroundWork?.(task.threadId))) return true;
      }
      const terminal = deps.terminal();
      if (!terminal) return false;
      const panes = await terminalPaneCountsResponse(terminal);
      // Until panes capture an account, a live pane cannot prove it is unrelated.
      return panes.status !== 200 || !("counts" in panes.body) || Object.values(panes.body.counts).some((count) => count > 0);
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
  });
}
