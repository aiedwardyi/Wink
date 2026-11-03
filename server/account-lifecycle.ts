import type { ProviderSnapshot } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { AccountError, AccountService, type AccountRecord } from "./accounts.ts";
import type { BotAccounts } from "./bot-accounts.ts";

type Hooks = {
  reload(): Promise<void>;
  referenced(id: string, activeOnly: boolean): Promise<boolean>;
  invalidate(id: string): void;
  configBusy?(): boolean;
  panesBusy?(): Promise<boolean>;
};

export class AccountLifecycle {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, object>();
  private pending = new Map<string, Promise<void>>();
  private mutations = 0;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private results = new Map<string, { state: "failed" | "cancelled"; error?: "device_cap" }>();
  readonly accounts: AccountService;
  private readonly registry: ProviderRegistry;
  private readonly hooks: Hooks;
  readonly bots?: BotAccounts;

  constructor(accounts: AccountService, registry: ProviderRegistry, hooks: Hooks, bots?: BotAccounts) {
    this.accounts = accounts;
    this.registry = registry;
    this.hooks = hooks;
    this.bots = bots;
    registry.onAccountIdentity((id, snapshot) => this.observe(id, snapshot));
    for (const account of accounts.snapshot) registry.blockAccount(account.id, account.state !== "ready");
    for (const id of Object.keys(accounts.drains)) registry.blockAccount(id, true);
  }

  get busy() { return this.mutations > 0 || this.jobs.size > 0 || Object.values(this.accounts.drains).some((row) => row.phase !== "failed"); }
  settled(id: string) { return this.pending.get(id) ?? Promise.resolve(); }
  signInResult(id: string) { return this.results.get(id); }

  async restore() {
    for (const [id, drain] of Object.entries(this.accounts.drains)) {
      if (drain.phase === "logout") await this.accounts.drain(id, drain.destinationId, "failed");
    }
    for (const account of [...this.accounts.snapshot]) {
      if (this.accounts.drains[account.id]) continue;
      if (account.state === "pending") await this.discard(account.id);
      else if (account.state === "ready") {
        this.registry.blockAccount(account.id, true);
        const snapshot = await this.registry.get(account.id)?.snapshot({ refresh: true });
        if (snapshot?.authenticated === true && snapshot.accountIdentity && snapshot.accountIdentity === account.identity) this.registry.blockAccount(account.id, false);
        else await this.observe(account.id, snapshot ?? { state: "unavailable" });
      }
    }
    await this.resumeDrains();
  }

  dispose() { this.disposed = true; clearTimeout(this.drainTimer); }

  resumeDrains() {
    return this.exclusive(async () => {
      for (const [id, drain] of Object.entries(this.accounts.drains)) {
        if (drain.phase !== "failed") await this.advanceDrain(id);
      }
      this.scheduleDrains();
    }, false);
  }

  useForBots(id: string) {
    return this.exclusive(async () => {
      if (!this.bots) throw new AccountError("Account routing is unavailable", 503);
      await this.bots.useForBots(id);
      return {};
    });
  }

  add(of: string, device = false) {
    return this.exclusive(async () => {
      const account = await this.accounts.add(of);
      this.registry.blockAccount(account.id, true);
      try {
        await this.hooks.reload();
        const capture = await this.begin(account, device);
        return { id: account.id, generation: account.generation, ...capture };
      } catch (error) {
        await this.discard(account.id);
        throw error;
      }
    });
  }

  signIn(id: string, device = false) {
    return this.exclusive(async () => {
      if (Object.values(this.accounts.drains).some((row) => row.destinationId === id)) throw new AccountError("This account is the destination of a pending removal");
      const drain = this.accounts.drains[id];
      if (drain?.phase === "failed") await this.accounts.clearDrain(id);
      else if (drain) throw new AccountError("This account is draining");
      const account = this.accounts.get(id);
      if (!account) {
        if (!this.accounts.list().some((row) => row.id === id && row.existing)) throw new AccountError("Unknown account", 404);
        const capture = await this.registry.startSignIn(id, device);
        if (this.registry.accountBlocked(id)) {
          const finished = this.registry.logins.wait(id).then(async () => {
            const snapshot = await this.registry.get(id)?.snapshot({ refresh: true });
            if (snapshot?.authenticated === true) this.registry.blockAccount(id, false);
          }).finally(() => { this.pending.delete(id); });
          this.pending.set(id, finished);
        }
        return capture;
      }
      if (this.jobs.has(id)) return this.registry.logins.capture(id);
      this.registry.blockAccount(id, true);
      try {
        if (await this.hooks.referenced(id, true)) throw new AccountError("Finish this account's active work before signing in");
        return await this.begin(account, device);
      } catch (error) {
        if (account.state === "pending") await this.discard(id);
        else this.registry.blockAccount(id, account.state !== "ready");
        throw error;
      }
    });
  }

  cancel(id: string) {
    return this.exclusive(async () => {
      if (!this.accounts.list().some((row) => row.id === id)) throw new AccountError("Unknown account", 404);
      await this.registry.cancelSignIn(id);
      return {};
    });
  }

  remove(id: string, destinationId?: string) {
    return this.exclusive(async () => {
      if (Object.values(this.accounts.drains).some((row) => row.destinationId === id)) throw new AccountError("This account is the destination of a pending removal");
      if (!destinationId && this.accounts.drains[id]) throw new AccountError("Use the recorded removal destination to retry explicitly");
      if (destinationId) {
        if (!this.bots) throw new AccountError("Bot account routing is unavailable", 503);
        this.bots.destination(id, destinationId);
        if (await this.hooks.panesBusy?.()) throw new AccountError("This account is still used by a pane or pane state is unknown");
        const current = this.accounts.drains[id];
        if (current && (current.destinationId !== destinationId || current.phase !== "failed")) {
          throw new AccountError("This account already has a recorded removal destination");
        }
        const blocked = this.registry.accountBlocked(id);
        this.registry.blockAccount(id, true);
        try { await this.accounts.drain(id, destinationId); }
        catch (error) { this.registry.blockAccount(id, blocked); throw error; }
        try { return await this.advanceDrain(id); } finally { this.scheduleDrains(); }
      }
      const account = this.accounts.get(id);
      const lastExisting = !account && this.accounts.list().some((row) => row.id === id && row.existing) && !this.accounts.snapshot.some((row) => row.of === id);
      if (this.bots?.hasReferences(id) && !lastExisting) throw new AccountError("This account is still used by a bot or pending choice; a confirmed destination account id is required", 400);
      if (!account) {
        if (!this.accounts.list().some((row) => row.id === id && row.existing)) throw new AccountError("Unknown account", 404);
        const guarded = this.accounts.snapshot.length > 0;
        if (guarded) {
          const blocked = this.registry.accountBlocked(id);
          this.registry.blockAccount(id, true);
          if (await this.hooks.referenced(id, true) || await this.hooks.panesBusy?.()) {
            this.registry.blockAccount(id, blocked);
            throw new AccountError("This account is still used by a turn, helper or pane");
          }
        }
        const success = await this.registry.signOut(id);
        if (!success) throw new AccountError("Sign-out failed", 502);
        if (guarded) this.hooks.invalidate(id);
        return {};
      }
      this.registry.blockAccount(id, true);
      if (await this.hooks.referenced(id, false)) {
        this.registry.blockAccount(id, account.state !== "ready" || this.jobs.has(id));
        throw new AccountError("This account is still used by a bot, pending choice, turn or pane");
      }
      this.jobs.delete(id);
      await this.accounts.stop(id);
      await this.registry.cancelSignIn(id);
      if (await this.registry.signOut(id) !== true) throw new AccountError("Sign-out did not finish; the account is stopped", 502);
      await this.discard(id);
      return {};
    });
  }

  observe(id: string, snapshot: ProviderSnapshot, generation?: number): Promise<void> {
    const account = this.accounts.get(id);
    if (!account || this.accounts.drains[id] || (generation !== undefined && generation !== account.generation) || account.state !== "ready" || this.jobs.has(id)) return Promise.resolve();
    if (snapshot.authenticated === true && snapshot.accountIdentity && snapshot.accountIdentity === account.identity) return Promise.resolve();
    this.registry.blockAccount(id, true);
    return this.exclusive(async () => {
      const current = this.accounts.get(id);
      if (!current || current.generation !== account.generation) return;
      if (await this.hooks.referenced(id, true)) {
        await this.accounts.stop(id);
        return;
      }
      await this.accept(current, snapshot);
    }, false);
  }

  private async advanceDrain(id: string) {
    const drain = this.accounts.drains[id];
    if (!drain || drain.phase === "failed") return { state: "stopped" };
    let destination;
    try { destination = this.bots!.destination(id, drain.destinationId); }
    catch (error) {
      if (drain.phase === "draining") await this.accounts.drain(id, drain.destinationId, "failed");
      throw error;
    }
    if (drain.phase === "draining") {
      if (await this.hooks.referenced(id, true) || this.jobs.has(id) || await this.hooks.panesBusy?.()) return { state: "draining", destinationId: drain.destinationId };
      await this.registry.cancelSignIn(id);
      await this.accounts.drain(id, drain.destinationId, "logout");
      try {
        if (await this.registry.signOut(id) !== true) throw new Error("Sign-out not confirmed");
      } catch {
        await this.accounts.drain(id, drain.destinationId, "failed");
        throw new AccountError("Sign-out did not finish; the account is stopped", 502);
      }
      await this.accounts.drain(id, drain.destinationId, "signed-out");
    }
    const added = Boolean(this.accounts.get(id));
    await this.accounts.finishDrain(id, destination, () => { this.bots!.destination(id, drain.destinationId); });
    this.hooks.invalidate(id);
    await this.hooks.reload();
    this.registry.blockAccount(id, !added);
    return { state: "removed", destinationId: drain.destinationId };
  }

  private scheduleDrains() {
    clearTimeout(this.drainTimer);
    if (this.disposed || !Object.values(this.accounts.drains).some((row) => row.phase === "draining" || row.phase === "signed-out")) return;
    this.drainTimer = setTimeout(() => {
      void this.resumeDrains().catch(() => { this.scheduleDrains(); });
    }, 250);
    this.drainTimer.unref?.();
  }

  private async begin(account: AccountRecord, device: boolean) {
    const token = {};
    this.jobs.set(account.id, token);
    let capture;
    try {
      capture = await this.registry.startSignIn(account.id, device);
      if (!capture) throw new AccountError("Unknown engine sign-in", 404);
    } catch (error) {
      this.jobs.delete(account.id);
      throw error;
    }
    const finished = this.registry.logins.wait(account.id).then(() => this.exclusive(async () => {
      if (this.jobs.get(account.id) !== token || !this.accounts.get(account.id)) return;
      const state = this.registry.logins.state(account.id);
      const error = this.registry.logins.capture(account.id).error;
      const snapshot = await this.registry.get(account.id)?.snapshot({ refresh: true }).catch(() => undefined);
      this.jobs.delete(account.id);
      if (this.accounts.drains[account.id]) {
        await this.accounts.stop(account.id);
        this.registry.blockAccount(account.id, true);
        return;
      }
      if (state === "complete" && snapshot?.authenticated === true) {
        await this.accept(this.accounts.get(account.id)!, snapshot, true);
        this.registry.logins.acknowledge(account.id, true);
      } else {
        this.results.set(account.id, { state: state === "cancelled" ? "cancelled" : "failed", ...(error ? { error } : {}) });
        if (this.results.size > 50) this.results.delete(this.results.keys().next().value!);
        if (account.state === "pending") await this.discard(account.id);
        else await this.accept(this.accounts.get(account.id)!, { state: "available", authenticated: false });
      }
    }, false)).catch(() => this.exclusive(async () => {
      this.jobs.delete(account.id);
      const current = this.accounts.get(account.id);
      try {
        if (current?.state === "pending") await this.discard(account.id);
        else if (current) await this.accounts.stop(account.id);
      } catch { console.error("Account sign-in state could not be saved"); }
    }, false)).finally(() => { if (this.pending.get(account.id) === finished) this.pending.delete(account.id); });
    this.pending.set(account.id, finished);
    return capture;
  }

  private async accept(account: AccountRecord, snapshot: ProviderSnapshot, force = false) {
    if (force || snapshot.authenticated !== true || !snapshot.accountIdentity || snapshot.accountIdentity !== account.identity) this.hooks.invalidate(account.id);
    const next = await this.accounts.identify(account.id, snapshot.authenticated === true ? snapshot.accountIdentity : undefined, force);
    if (snapshot.authenticated !== true) await this.accounts.stop(account.id);
    if (next.generation !== account.generation || snapshot.authenticated !== true) await this.hooks.reload();
    this.registry.blockAccount(account.id, snapshot.authenticated !== true);
  }

  private async discard(id: string) {
    this.hooks.invalidate(id);
    await this.accounts.retire(id);
    await this.hooks.reload();
    this.registry.blockAccount(id, false);
  }

  private exclusive<T>(run: () => Promise<T>, checkConfig = true): Promise<T> {
    this.mutations += 1;
    const pending = this.queue.then(() => {
      if (checkConfig && this.hooks.configBusy?.()) throw new AccountError("Provider settings are being updated");
      return run();
    }).finally(() => { this.mutations -= 1; });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
