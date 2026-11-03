import { isEffortOffered } from "../shared/model-effort.ts";
import { AccountError, type AccountService } from "./accounts.ts";
import type { AutomaticCandidate, AutomaticCapability } from "./automatic-selection.ts";
import type { ModelSelection, ProviderInstance } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { BotRecord, Store } from "./store.ts";

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
    const accountId = this.accounts.defaultFor(selection.instanceId);
    if (!accountId) {
      if (this.accounts.drains[selection.instanceId]) throw new AccountError("This account is draining; choose an account");
      if (this.accounts.get(selection.instanceId)) throw new AccountError("Choose this engine's default account before starting it");
      return selection;
    }
    const instance = this.validate(accountId, selection);
    if (required.some((capability) => capability === "approvalReview" ? !instance.reviewPermission : instance.adapter.capabilities[capability] !== true)) {
      throw new AccountError("This account cannot run this bot's tools; choose an account");
    }
    return { ...selection, instanceId: accountId };
  }

  instance(bot: BotRecord, threadId = bot.activeThreadId ?? bot.threadId): ProviderInstance | null {
    const captured = this.captured(threadId);
    if (captured) return captured;
    try { return this.registry.get(this.resolve(bot).instanceId); } catch { return null; }
  }

  catalogInstanceId(selection: ModelSelection) {
    return this.accounts.defaultFor(selection.instanceId) ?? selection.instanceId;
  }

  checkSelection(selection: ModelSelection): ModelSelection {
    if (/^acct_[0-9a-f-]{36}$/.test(selection.instanceId)) throw new AccountError("Choose an engine's default account on the Usage page", 400);
    const accountId = this.accounts.defaultFor(selection.instanceId);
    if (accountId) this.validate(accountId, selection);
    return selection;
  }

  automaticCandidate(candidate: AutomaticCandidate, lookup: (id: string) => AutomaticCandidate | undefined): AutomaticCandidate {
    const accountId = this.accounts.defaultFor(candidate.instanceId);
    if (!accountId) return this.accounts.drains[candidate.instanceId] ? { ...candidate, available: false } : candidate;
    const selected = lookup(accountId);
    return { ...(selected ?? candidate), instanceId: candidate.instanceId, accountOf: candidate.accountOf,
      available: Boolean(selected?.available && this.available(accountId)),
    };
  }

  useForBots(id: string) {
    const account = this.accounts.list().find((row) => row.id === id);
    if (!account) throw new AccountError("Unknown account", 404);
    if (!this.available(id)) throw new AccountError("This account is unavailable or draining; choose an account");
    for (const bot of this.store.bots) {
      for (const selection of this.selections(bot)) if (selection.instanceId === account.of) this.validate(id, selection);
    }
    return this.accounts.setDefault(account.of, id);
  }

  noteAccount() {
    const claude = this.registry.instances().find((instance) => instance.driverKind === "claudeAgent" && !instance.account && instance.enabled && instance.generateText);
    const id = claude && this.accounts.defaultFor(claude.instanceId);
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

  private available(id: string) {
    const account = this.accounts.get(id);
    return !this.accounts.drains[id] && (!account || account.state === "ready") && this.registry.accountAvailable(id);
  }

  private validate(id: string, selection: ModelSelection) {
    const instance = this.registry.get(id);
    if (!instance || !this.available(id)) throw new AccountError("This account is unavailable or draining; choose an account");
    if (selection.model !== instance.models.default && !instance.models.options.some((option) => option.id === selection.model)) {
      throw new AccountError("This account does not offer the selected model; choose a model first", 400);
    }
    if (selection.effort && !isEffortOffered(instance.driverKind, selection.model, selection.effort, instance.adapter.capabilities.effortLevels ?? [])) {
      throw new AccountError("This account does not offer the selected effort; choose an effort first", 400);
    }
    return instance;
  }
}
