import { isEffortOffered } from "../shared/model-effort.ts";
import { AccountError, type AccountService } from "./accounts.ts";
import type { AutomaticCandidate, AutomaticCapability } from "./automatic-selection.ts";
import type { ModelCatalog, ModelSelection, ProviderInstance, ProviderSnapshot } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { BotRecord, Store } from "./store.ts";

export const SIGNED_OUT = "This account is signed out. Sign in again, then send your message.";

export class BotAccounts {
  private readonly accounts: AccountService;
  private readonly registry: ProviderRegistry;
  private readonly store: Store;
  private readonly captured: (threadId: string) => ProviderInstance | null;

  constructor(accounts: AccountService, registry: ProviderRegistry, store: Store, hooks: {
    captured(threadId: string): ProviderInstance | null;
  }) {
    this.accounts = accounts;
    this.registry = registry;
    this.store = store;
    this.captured = hooks.captured;
  }

  resolve(bot: Pick<BotRecord, "modelSelection">, required: readonly AutomaticCapability[] = []): ModelSelection {
    const selection = bot.modelSelection;
    const accountId = this.routedAccount(selection.instanceId);
    if (!accountId) {
      if (this.accounts.drains[selection.instanceId]) throw new AccountError("This account is draining. Use Set as Main on the Usage page");
      if (this.accounts.get(selection.instanceId)) throw new AccountError("Use Set as Main on the Usage page before starting this engine");
      if (this.registry.accountBlocked(selection.instanceId)) throw new AccountError(SIGNED_OUT);
      return selection;
    }
    const instance = this.validate(accountId, selection);
    if (required.some((capability) => capability === "approvalReview" ? !instance.reviewPermission : instance.adapter.capabilities[capability] !== true)) {
      throw new AccountError("This account cannot run this bot's tools. Use Set as Main on the Usage page to choose another account");
    }
    return { ...selection, instanceId: accountId };
  }

  instance(bot: BotRecord, threadId = bot.activeThreadId ?? bot.threadId): ProviderInstance | null {
    const captured = this.captured(threadId);
    if (captured) return captured;
    try { return this.registry.get(this.resolve(bot).instanceId); } catch { return null; }
  }

  catalogInstanceId(selection: ModelSelection) {
    return this.routedAccount(selection.instanceId) ?? selection.instanceId;
  }

  pickerInstances<T extends { instanceId: string; snapshot: ProviderSnapshot; models?: ModelCatalog }>(instances: T[]): Array<T & { pickerSnapshot?: ProviderSnapshot; pickerModels?: ModelCatalog }> {
    return instances.map((instance) => {
      if (this.accounts.get(instance.instanceId)) return instance;
      const id = this.routedAccount(instance.instanceId);
      if (!id && !this.accounts.drains[instance.instanceId]) return instance;
      const main = instances.find((row) => row.instanceId === id);
      return { ...instance, pickerSnapshot: id && this.available(id) && main ? main.snapshot : { state: "unavailable" },
        ...(main?.models ? { pickerModels: main.models } : {}),
      };
    });
  }

  accountInstances<T extends { instanceId: string }>(instances: T[]): Array<T & {
    accountOf?: string; accountMain?: boolean; accountState?: "pending" | "ready" | "stopped"; drain?: AccountService["drains"][string];
  }> {
    const accounts = this.accounts.list();
    return instances.map((instance) => {
      const account = accounts.find((row) => row.id === instance.instanceId);
      if (!account) return instance;
      return { ...instance, accountOf: account.of, accountMain: !account.error && this.accounts.isDefault(account.id),
        accountState: account.existing && this.registry.accountBlocked(account.id) ? "stopped" as const : account.state,
        ...(this.accounts.drains[account.id] ? { drain: this.accounts.drains[account.id] } : {}),
      };
    });
  }

  checkSelection(selection: ModelSelection): ModelSelection {
    if (/^acct_[0-9a-f-]{36}$/.test(selection.instanceId)) throw new AccountError("Use Set as Main on the Usage page to choose this engine's account", 400);
    const accountId = this.routedAccount(selection.instanceId);
    if (accountId) this.validate(accountId, selection);
    return selection;
  }

  automaticCandidate(candidate: AutomaticCandidate, lookup: (id: string) => AutomaticCandidate | undefined): AutomaticCandidate {
    const accountId = this.routedAccount(candidate.instanceId);
    if (!accountId) return this.accounts.drains[candidate.instanceId] ? { ...candidate, available: false } : candidate;
    const selected = accountId === candidate.instanceId ? candidate : lookup(accountId);
    return { ...(selected ?? candidate), instanceId: candidate.instanceId, accountOf: candidate.accountOf,
      available: Boolean(selected?.available && this.available(accountId)),
    };
  }

  useForBots(id: string) {
    const account = this.accounts.list().find((row) => row.id === id);
    if (!account) throw new AccountError("Unknown account", 404);
    if (!this.available(id)) throw new AccountError("This account is unavailable or draining. Sign in again in Settings > Connections");
    for (const bot of this.store.bots) {
      for (const selection of this.selections(bot)) if (selection.instanceId === account.of) this.validate(id, selection);
    }
    return this.accounts.setDefault(account.of, id);
  }

  // undefined: no Main configured. null: Main configured but unavailable.
  mainAccount(of: string) {
    const id = this.routedAccount(of);
    return id ? (this.available(id) ? this.accounts.get(id) : null) : undefined;
  }

  noteAccount() {
    const claude = this.registry.instances().find((instance) => instance.driverKind === "claudeAgent" && !instance.account && instance.enabled && instance.generateText);
    const id = claude && this.routedAccount(claude.instanceId);
    return id ? { instanceId: id, available: this.available(id) } : undefined;
  }

  references(bot: BotRecord, id: string): boolean {
    return this.selections(bot).some((selection) => (this.accounts.defaultFor(selection.instanceId) ?? selection.instanceId) === id);
  }

  hasReferences(id: string) {
    return this.accounts.list().some((row) => row.id === id && this.accounts.isDefault(id)) || this.store.bots.some((bot) => this.references(bot, id));
  }

  destination(id: string, destinationId: string) {
    const source = this.accounts.list().find((row) => row.id === id);
    const destination = this.accounts.list().find((row) => row.id === destinationId);
    if (!source || !destination || id === destinationId || source.of !== destination.of) throw new AccountError("Choose a different account of this profile by id", 400);
    if (!this.available(destinationId)) throw new AccountError("The destination account is unavailable or draining");
    for (const bot of this.store.bots) {
      for (const selection of this.selections(bot)) {
        if ((this.accounts.defaultFor(selection.instanceId) ?? selection.instanceId) === id) this.validate(destinationId, selection);
      }
    }
    return { of: destination.of, accountId: destinationId };
  }

  private selections(bot: BotRecord) {
    return bot.pendingModelSelection ? [bot.modelSelection, bot.pendingModelSelection] : [bot.modelSelection];
  }

  private routedAccount(of: string) {
    const id = this.accounts.defaultFor(of) ?? of;
    const drain = this.accounts.drains[id];
    return drain && drain.phase !== "failed" ? drain.destinationId : id !== of ? id : undefined;
  }

  private available(id: string) {
    const account = this.accounts.get(id);
    return !this.accounts.drains[id] && (!account || account.state === "ready") && this.registry.accountAvailable(id);
  }

  private validate(id: string, selection: ModelSelection) {
    const instance = this.registry.get(id);
    if (!instance || !this.available(id)) {
      throw new AccountError(!this.accounts.drains[id] && this.registry.accountBlocked(id) ? SIGNED_OUT : "This account is unavailable or draining. Sign in again in Settings > Connections");
    }
    if (selection.model !== instance.models.default && !instance.models.options.some((option) => option.id === selection.model)) {
      throw new AccountError("This account does not offer the selected model; choose a model first", 400);
    }
    if (selection.effort && !isEffortOffered(instance.driverKind, selection.model, selection.effort, instance.adapter.capabilities.effortLevels ?? [])) {
      throw new AccountError("This account does not offer the selected effort; choose an effort first", 400);
    }
    return instance;
  }
}
