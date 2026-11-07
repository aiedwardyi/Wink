import { AccountError, type AccountService } from "./accounts.ts";
import { AccountLifecycle, type MainChange } from "./account-lifecycle.ts";
import { BotAccounts } from "./bot-accounts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { ProviderReload } from "./harness/provider-reload.ts";
import type { Store } from "./store.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";
import type { createUsageRefresh } from "./usage-refresh.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";
import { livePanesForAccount } from "./worker-panes.ts";

export function createAccountRuntime(deps: {
  accounts: AccountService; registry: ProviderRegistry; providers: ProviderReload; store: Store;
  reload(): Promise<void>; rateLimits: RateLimitsMap; saveRateLimits(): void;
  usage: ReturnType<typeof createUsageRefresh>; availability: Map<string, boolean>;
  invalidateHolds(id: string): void; invalidateWaits(id: string): void;
  botActive(id: string): boolean; terminal(): TerminalBridgeAccess | null; configBusy(): boolean;
  bots?: BotAccounts;
  changed?(usageId?: string): void;
  onMainChanged?(change: MainChange): void;
}) {
  const bots = deps.bots ?? new BotAccounts(deps.accounts, deps.registry, deps.store, {
    captured: (threadId) => deps.providers.current(threadId),
  });
  const starting = new Set<{ id: string; generation: number }>();
  const lifecycle = new AccountLifecycle(deps.accounts, deps.registry, {
    reload: deps.reload,
    changed: deps.changed,
    onMainChanged: deps.onMainChanged,
    configBusy: deps.configBusy,
    panesBusy: (id) => accountPanesBusy(deps.terminal(), id),
    referenced: async (id, activeOnly) => {
      if (!activeOnly && deps.accounts.defaultFor(deps.accounts.get(id)?.of ?? id) === id) return true;
      if ([...starting].some((hold) => hold.id === id && hold.generation === (deps.accounts.get(id)?.generation ?? 0))) return true;
      if (deps.providers.inUse(id) || deps.registry.accountBusy(id) || deps.usage.busy(id)) return true;
      for (const bot of deps.store.bots) {
        const selected = bots.references(bot, id);
        const captured = deps.providers.current(bot.activeThreadId ?? bot.threadId);
        if (selected && (!activeOnly || (deps.botActive(bot.id) && !captured))) return true;
        const of = deps.accounts.get(id)?.of ?? id;
        // A dispatch claim may still be setting up its captured instance.
        if (activeOnly && !captured && deps.botActive(bot.id) && [bot.modelSelection, bot.pendingModelSelection].some((selection) => selection?.instanceId === of)) return true;
        if ((bot.tasks ?? []).some((task) => deps.registry.get(id)?.adapter.hasSession(task.threadId) || deps.registry.get(id)?.adapter.hasBackgroundWork?.(task.threadId))) return true;
      }
      return activeOnly ? false : accountPanesBusy(deps.terminal(), id);
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
  return Object.assign(lifecycle, {
    holdStarting(accountId: string, generation: number) {
      const hold = { id: accountId, generation };
      starting.add(hold);
      return () => { starting.delete(hold); };
    },
  });
}

export async function accountPanesBusy(terminal: TerminalBridgeAccess | null, id: string): Promise<boolean> {
  const panes = await livePanesForAccount(terminal, id);
  if (panes.unknown) throw new AccountError("Terminal host is unreachable or account pane state is unknown; try signing out again when the host is available", 409, "host-unknown");
  return panes.count > 0;
}
