import { isEffortOffered } from "../shared/model-effort.ts";
import { AccountError, type AccountService, type BotAccountBinding, type BotAccountState } from "./accounts.ts";
import type { ModelSelection, ProviderInstance } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { modelPickPatch } from "./pending-model.ts";
import type { BotRecord, Store } from "./store.ts";

export class BotAccounts {
  private readonly accounts: AccountService;
  private readonly registry: ProviderRegistry;
  private readonly store: Store;
  private readonly active: (botId: string) => boolean;
  private readonly captured: (threadId: string) => ProviderInstance | null;

  constructor(accounts: AccountService, registry: ProviderRegistry, store: Store, hooks: {
    active(botId: string): boolean; captured(threadId: string): ProviderInstance | null;
  }) {
    this.accounts = accounts;
    this.registry = registry;
    this.store = store;
    this.active = hooks.active;
    this.captured = hooks.captured;
  }

  resolve(bot: BotRecord): ModelSelection {
    const binding = this.accounts.binding(bot.id)?.current;
    if (!binding) {
      if (this.accounts.drains[bot.modelSelection.instanceId]) throw new AccountError("This account is draining; choose an account");
      if (this.accounts.get(bot.modelSelection.instanceId)) throw new AccountError("Choose this bot's local account before starting it");
      return bot.modelSelection;
    }
    if (binding.of !== bot.modelSelection.instanceId) throw new AccountError("This bot's model changed profiles; choose its account");
    this.validate(binding.accountId, bot.modelSelection);
    return { ...bot.modelSelection, instanceId: binding.accountId, mode: "pinned" };
  }

  instance(bot: BotRecord, threadId = bot.activeThreadId ?? bot.threadId): ProviderInstance | null {
    const captured = this.captured(threadId);
    if (captured) return captured;
    try { return this.registry.get(this.resolve(bot).instanceId); } catch { return null; }
  }

  async settle(botId: string, claimed = false) {
    const bot = this.store.bot(botId);
    if (this.accounts.binding(botId)?.pending === undefined || !bot) return;
    const ready = () => !(claimed ? bot.busy || this.captured(bot.activeThreadId ?? bot.threadId) : this.active(botId));
    if (!ready()) return;
    await this.accounts.settleBinding(botId, ready);
    if (ready() && bot.pendingModelSelection) this.store.patchBot(bot.id, modelPickPatch({ ...bot, busy: false }, bot.pendingModelSelection));
  }

  async settlePending() {
    for (const botId of this.accounts.pendingBindings) await this.settle(botId);
  }

  hasBinding(botId: string) { return this.accounts.binding(botId) !== undefined; }
  hasPending(botId: string) { return this.accounts.binding(botId)?.pending !== undefined; }

  catalogInstanceId(bot: BotRecord | undefined, selection: ModelSelection) {
    const row = bot && this.accounts.binding(bot.id);
    const binding = row?.pending ?? row?.current;
    return binding?.of === selection.instanceId ? binding.accountId : selection.instanceId;
  }

  checkSelection(bot: BotRecord | undefined, selection: ModelSelection): ModelSelection {
    if (/^acct_[0-9a-f-]{36}$/.test(selection.instanceId)) throw new AccountError("Choose an account through this bot's Account control", 400);
    const row = bot && this.accounts.binding(bot.id);
    const binding = row?.pending ?? row?.current;
    if (!binding || binding.of !== selection.instanceId) return selection;
    this.validate(binding.accountId, selection);
    return { ...selection, mode: "pinned" };
  }

  async pickModel(bot: BotRecord, selection: ModelSelection) {
    let checked = this.checkSelection(bot, selection);
    const row = this.accounts.binding(bot.id);
    const binding = row?.pending ?? row?.current;
    if (binding && binding.of !== selection.instanceId) {
      const target = this.accounts.list().some((account) => account.id === selection.instanceId)
        ? this.validate(selection.instanceId, selection) : null;
      await this.accounts.bind([{ botId: bot.id, binding: target, pending: () => this.active(bot.id) }]);
      if (target) checked = { ...checked, mode: "pinned" };
    }
    return modelPickPatch({ ...bot, busy: this.active(bot.id) }, checked);
  }

  async pick(botId: string, accountId: string) {
    const bot = this.store.bot(botId);
    if (!bot) throw new AccountError("Unknown bot", 404);
    const held = this.accounts.binding(botId);
    if ((held?.current && this.accounts.drains[held.current.accountId]) || (held?.pending && this.accounts.drains[held.pending.accountId])) {
      throw new AccountError("Finish this bot's account removal before changing its account");
    }
    const selection = bot.pendingModelSelection ?? bot.modelSelection;
    const binding = this.validate(accountId, selection);
    const next: ModelSelection = { ...selection, instanceId: binding.of, mode: "pinned" };
    await this.accounts.bind([{ botId, binding, pending: () => this.active(bot.id) }]);
    this.store.patchBot(botId, modelPickPatch({ ...bot, busy: this.active(bot.id) || this.hasPending(bot.id) }, next));
    return this.describe(bot);
  }

  describe(bot: BotRecord) {
    const row = this.accounts.binding(bot.id);
    const accountId = row?.current?.accountId ?? bot.modelSelection.instanceId;
    const instance = this.registry.get(accountId);
    return { accountId, pendingAccountId: row?.pending?.accountId ?? null,
      of: row?.current?.of ?? bot.modelSelection.instanceId,
      models: instance?.models, effortLevels: instance?.adapter.capabilities.effortLevels,
    };
  }

  describeById(botId: string) {
    const bot = this.store.bot(botId);
    if (!bot) throw new AccountError("Unknown bot", 404);
    return this.describe(bot);
  }

  noteAccount(bot: BotRecord | undefined) {
    if (!bot) return undefined;
    const row = this.accounts.binding(bot.id);
    if (!row) return undefined;
    const idle = !this.active(bot.id);
    const selection = idle ? bot.pendingModelSelection ?? bot.modelSelection : bot.modelSelection;
    if (this.registry.get(selection.instanceId)?.driverKind !== "claudeAgent") return undefined;
    const binding = idle && row?.pending !== undefined ? row.pending : row?.current;
    if (!binding) return undefined;
    const kind = this.registry.get(binding.of)?.driverKind;
    if (kind && kind !== "claudeAgent") return undefined;
    return { instanceId: binding.accountId, available: this.available(binding.accountId) };
  }

  references(bot: BotRecord, id: string): boolean {
    return this.selections(bot).some((choice) => choice.id === id);
  }

  hasReferences(id: string) { return this.store.bots.some((bot) => this.references(bot, id)); }
  hasLocalReferences(id: string) {
    return this.store.bots.some((bot) => {
      const row = this.accounts.binding(bot.id);
      return row?.current?.accountId === id || row?.pending?.accountId === id;
    });
  }

  destination(id: string, destinationId: string): BotAccountBinding {
    const source = this.accounts.list().find((row) => row.id === id);
    const destination = this.accounts.list().find((row) => row.id === destinationId);
    if (!source || !destination || id === destinationId || source.of !== destination.of) throw new AccountError("Choose a different account of this profile by id", 400);
    if (!this.available(destinationId)) throw new AccountError("The destination account is unavailable or draining");
    for (const bot of this.store.bots) {
      for (const choice of this.selections(bot)) if (choice.id === id) this.validate(destinationId, choice.selection);
    }
    return { of: destination.of, accountId: destinationId };
  }

  async move(id: string, destinationId: string) {
    if (this.accounts.drains[id]) throw new AccountError("This account is already draining");
    const destination = this.destination(id, destinationId);
    const bots = this.store.bots.filter((bot) => this.references(bot, id));
    for (const bot of bots) this.validate(destinationId, bot.pendingModelSelection ?? bot.modelSelection);
    await this.accounts.bind(bots.map((bot) => ({ botId: bot.id, binding: destination, pending: () => this.active(bot.id) })));
    for (const bot of bots) this.store.patchBot(bot.id, modelPickPatch({ ...bot, busy: this.active(bot.id) }, {
      ...(bot.pendingModelSelection ?? bot.modelSelection), instanceId: destination.of, mode: "pinned",
    }));
    return { moved: bots.length, destinationId };
  }

  removalPlan(id: string, destination: BotAccountBinding) {
    const bindings: Record<string, BotAccountState> = {};
    const bots: { id: string; current: boolean; pending: boolean }[] = [];
    for (const bot of this.store.bots) {
      const choices = this.selections(bot);
      const current = choices.some((choice) => choice.kind === "current" && choice.id === id);
      const pending = choices.some((choice) => choice.kind === "pending" && choice.id === id);
      if (!current && !pending) continue;
      bindings[bot.id] = { ...this.accounts.binding(bot.id), ...(current ? { current: destination } : {}), ...(pending ? { pending: destination } : {}) };
      bots.push({ id: bot.id, current, pending });
    }
    return { bindings, bots };
  }

  applyRemoval(plan: ReturnType<BotAccounts["removalPlan"]>, id: string, destination: BotAccountBinding) {
    for (const moved of plan.bots) {
      const bot = this.store.bot(moved.id);
      if (!bot) continue;
      const pin = (selection: ModelSelection): ModelSelection => ({ ...selection, mode: "pinned", instanceId: selection.instanceId === id ? destination.of : selection.instanceId });
      this.store.patchBot(bot.id, { ...(moved.current ? { modelSelection: pin(bot.modelSelection) } : {}),
        ...(moved.pending && bot.pendingModelSelection ? { pendingModelSelection: pin(bot.pendingModelSelection) } : {}),
      });
    }
  }

  private selections(bot: BotRecord) {
    const row = this.accounts.binding(bot.id);
    const choices = [{ kind: "current", id: row?.current?.accountId ?? bot.modelSelection.instanceId, selection: bot.modelSelection }];
    if (row?.pending !== undefined) choices.push({ kind: "pending", id: row.pending?.accountId ?? bot.pendingModelSelection?.instanceId ?? bot.modelSelection.instanceId,
      selection: bot.pendingModelSelection ?? bot.modelSelection });
    else if (bot.pendingModelSelection) choices.push({ kind: "pending",
      id: row?.current?.of === bot.pendingModelSelection.instanceId ? row.current.accountId : bot.pendingModelSelection.instanceId,
      selection: bot.pendingModelSelection });
    return choices;
  }

  private available(id: string) {
    const account = this.accounts.get(id);
    return !this.accounts.drains[id] && (!account || account.state === "ready") && this.registry.accountAvailable(id);
  }

  private validate(id: string, selection: ModelSelection): BotAccountBinding {
    const account = this.accounts.list().find((row) => row.id === id);
    const instance = this.registry.get(id);
    if (!account || !instance || !this.available(id)) throw new AccountError("This account is unavailable or draining; choose an account");
    if (selection.model !== instance.models.default && !instance.models.options.some((option) => option.id === selection.model)) {
      throw new AccountError("This account does not offer the selected model; choose a model first", 400);
    }
    if (selection.effort && !isEffortOffered(instance.driverKind, selection.model, selection.effort, instance.adapter.capabilities.effortLevels ?? [])) {
      throw new AccountError("This account does not offer the selected effort; choose an effort first", 400);
    }
    return { of: account.of, accountId: id };
  }
}
