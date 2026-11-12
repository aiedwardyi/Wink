import type { ProviderSnapshot } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { AccountError, AccountService, type AccountRecord } from "./accounts.ts";
import type { BotAccounts } from "./bot-accounts.ts";
import { baseAccount } from "./worker-resume.ts";
import { clearCodexPromo, codexPromoBlocked } from "../electron/codex-promo.mjs";

type Hooks = {
  reload(): Promise<void>;
  referenced(id: string, activeOnly: boolean): Promise<boolean>;
  invalidate(id: string): void;
  changed?(usageId?: string): void;
  configBusy?(): boolean;
  panesBusy?(id: string, activeOnly?: boolean): Promise<boolean>;
  onMainChanged?(change: MainChange): void;
};

type Main = { id: string; generation: number };
export type MainChange = { base: string; engine: "claude" | "codex"; from: Main; to: Main; seq: number };

let mainSeq = 0;

export class AccountLifecycle {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, object>();
  private pending = new Map<string, Promise<void>>();
  private mutations = 0;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private retries = new Map<string, { delay: number; timer?: ReturnType<typeof setTimeout> }>();
  private disposed = false;
  private results = new Map<string, { state: "failed" | "cancelled"; error?: "device_cap" } | { state: "duplicate"; existingId: string }>();
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
  signInResult(id: string) {
    return this.results.get(id) ?? (this.pending.has(id) ? { ...this.registry.logins.capture(id), state: "pending" as const }
      : this.accounts.get(id)?.state === "ready" ? { state: "complete" as const } : undefined);
  }

  async restore() {
    for (const [id, drain] of Object.entries(this.accounts.drains)) {
      if (drain.phase === "logout") await this.accounts.drain(id, drain.destinationId, "failed");
    }
    for (const account of [...this.accounts.snapshot]) {
      if (this.accounts.drains[account.id]) continue;
      if (account.state === "pending") await this.discard(account.id);
      else if (account.state === "ready") {
        this.registry.blockAccount(account.id, true);
        const snapshot = await this.registry.get(account.id)?.snapshot({ refresh: true }).catch(() => undefined);
        await this.observe(account.id, snapshot ?? { state: "unavailable" }).catch(() => {
          console.error("Account restoration is waiting for recovery");
        });
      }
    }
    await this.resumeDrains().catch(() => {
      console.error("Account drain recovery failed");
      this.scheduleDrains();
    });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.drainTimer);
    for (const retry of this.retries.values()) clearTimeout(retry.timer);
    this.retries.clear();
  }

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
      const destinations = Object.values(this.accounts.drains).filter((row) => row.destinationId === id);
      if (destinations.some((row) => row.phase !== "signed-out") || (destinations.length > 0 && this.registry.accountAvailable(id))) throw new AccountError("This account is the destination of a pending removal");
      const drain = this.accounts.drains[id];
      if (drain?.phase === "failed") await this.accounts.clearDrain(id);
      else if (drain) throw new AccountError("This account is draining");
      const account = this.accounts.get(id);
      if (!account) {
        if (!this.accounts.list().some((row) => row.id === id && row.existing)) throw new AccountError("Unknown account", 404);
        const blocked = this.registry.accountBlocked(id);
        const home = this.promoHome(id);
        const guarded = blocked || (home && codexPromoBlocked(home)) || this.accounts.snapshot.length > 0 || destinations.length > 0;
        if (guarded) {
          this.registry.blockAccount(id, true);
          try {
            if (await this.hooks.referenced(id, true) || await this.hooks.panesBusy?.(id, blocked && destinations.length === 0)) throw new AccountError("Finish this account's active work before signing in", 409, "account-busy");
          } catch (error) {
            this.registry.blockAccount(id, blocked);
            throw error;
          }
        }
        let capture;
        try {
          capture = await this.registry.startSignIn(id, device);
          if (!capture) throw new AccountError("Unknown engine sign-in", 404);
        } catch (error) { if (guarded) this.registry.blockAccount(id, blocked); throw error; }
        if (this.registry.accountBlocked(id)) {
          const finished = this.registry.logins.wait(id).then(async () => {
            const snapshot = await this.registry.get(id)?.snapshot({ refresh: true });
            if (snapshot?.authenticated !== true) return;
            if (home && this.registry.logins.state(id) === "complete") clearCodexPromo(home);
            this.registry.blockAccount(id, false);
            this.hooks.changed?.();
          }).catch(() => { console.error("Account sign-in snapshot could not be refreshed"); })
            .finally(() => { if (this.pending.get(id) === finished) this.pending.delete(id); });
          this.pending.set(id, finished);
        }
        return capture;
      }
      if (this.jobs.has(id)) return this.registry.logins.capture(id);
      this.registry.blockAccount(id, true);
      try {
        if (await this.hooks.referenced(id, true) || await this.hooks.panesBusy?.(id, account.state === "stopped" && destinations.length === 0)) throw new AccountError("Finish this account's active work before signing in", 409, "account-busy");
        return await this.begin(account, device);
      } catch (error) {
        if (account.state === "pending") await this.discard(id);
        else this.registry.blockAccount(id, account.state !== "ready");
        throw error;
      }
    });
  }

  // Clears only through a successful sign-in; sessions, generation and Main stay.
  async signedOut(id: string) {
    const account = this.accounts.get(id);
    if (this.jobs.has(id) || this.pending.has(id) || this.registry.logins.state(id) === "pending" || this.accounts.drains[id] || (account && account.state !== "ready")) return;
    if (!account && this.registry.accountBlocked(id)) return;
    this.registry.blockAccount(id, true);
    if (!account) {
      this.hooks.changed?.();
      return;
    }
    await this.exclusive(async () => {
      const current = this.accounts.get(id);
      if (this.jobs.has(id) || this.pending.has(id) || this.registry.logins.state(id) === "pending" || this.accounts.drains[id]) return;
      if (current?.generation === account.generation && current.state === "ready") await this.accounts.stop(id);
    }, false).catch(() => { console.error("Signed-out account could not be saved"); });
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
        if (await this.hooks.panesBusy?.(id)) throw new AccountError("This account is still used by a pane");
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
          try {
            if (await this.hooks.referenced(id, true) || await this.hooks.panesBusy?.(id)) throw new AccountError("This account is still used by a turn, helper or pane");
          } catch (error) {
            this.registry.blockAccount(id, blocked);
            throw error;
          }
        }
        const success = await this.registry.signOut(id);
        if (!success) throw new AccountError("Sign-out failed", 502);
        if (guarded) this.hooks.invalidate(id);
        return {};
      }
      const blocked = this.registry.accountBlocked(id);
      this.registry.blockAccount(id, true);
      try {
        if (await this.hooks.referenced(id, false)) throw new AccountError("This account is still used by a bot, pending choice, turn or pane");
      } catch (error) {
        this.registry.blockAccount(id, blocked);
        throw error;
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
    if (snapshot.authenticated !== false && !(snapshot.authenticated === true && snapshot.accountIdentity)) {
      this.registry.blockAccount(id, true);
      this.retry(account);
      return Promise.resolve();
    }
    this.clearRetry(id);
    if (snapshot.authenticated === true && snapshot.accountIdentity === account.identity) {
      this.registry.blockAccount(id, false);
      return Promise.resolve();
    }
    this.registry.blockAccount(id, true);
    return this.exclusive(async () => {
      const current = this.accounts.get(id);
      if (!current || current.generation !== account.generation) return;
      if (await this.hooks.referenced(id, true) || await this.hooks.panesBusy?.(id)) {
        await this.accounts.stop(id);
        return;
      }
      await this.accept(current, snapshot);
    }, false).catch((error) => {
      this.retry(account);
      throw error;
    });
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
      if (await this.hooks.referenced(id, true) || this.jobs.has(id) || await this.hooks.panesBusy?.(id)) return { state: "draining", destinationId: drain.destinationId };
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
    this.clearRetry(id);
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

  private clearRetry(id: string) {
    clearTimeout(this.retries.get(id)?.timer);
    this.retries.delete(id);
  }

  private retry(account: AccountRecord) {
    const retry = this.retries.get(account.id) ?? { delay: 1_000, timer: undefined };
    if (this.disposed || retry.timer) return;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      const current = this.accounts.get(account.id);
      if (!current || current.state !== "ready" || current.generation !== account.generation || this.accounts.drains[account.id] || this.jobs.has(account.id)) {
        this.retries.delete(account.id);
        return;
      }
      retry.delay = Math.min(retry.delay * 2, 60_000);
      void this.registry.retryAccount(account.id).catch(() => this.retry(account));
    }, retry.delay);
    retry.timer.unref?.();
    this.retries.set(account.id, retry);
  }

  private async begin(account: AccountRecord, device: boolean) {
    const token = {};
    this.results.delete(account.id);
    this.jobs.set(account.id, token);
    let capture;
    try {
      capture = await this.registry.startSignIn(account.id, device);
      if (!capture) throw new AccountError("Unknown engine sign-in", 404);
    } catch (error) {
      this.jobs.delete(account.id);
      throw error;
    }
    const finished = this.registry.logins.wait(account.id).then(async () => {
      const queued = this.queue;
      await queued;
      const probes = account.state === "pending" && this.registry.logins.state(account.id) === "complete"
        ? await this.duplicateProbes(account) : undefined;
      const snapshots = this.queue === queued ? probes : undefined;
      return this.exclusive(async () => {
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
        if (state === "complete" && snapshot?.authenticated === true && snapshot.accountIdentity) {
          const existingId = account.state === "pending" && await this.duplicate(account, snapshot, snapshots);
          if (existingId) {
            this.results.set(account.id, { state: "duplicate", existingId });
            if (this.results.size > 50) this.results.delete(this.results.keys().next().value!);
            await this.discard(account.id);
            return;
          }
          await this.accept(this.accounts.get(account.id)!, snapshot, true);
          this.registry.logins.acknowledge(account.id, true);
        } else {
          this.results.set(account.id, { state: state === "cancelled" ? "cancelled" : "failed", ...(error ? { error } : {}) });
          if (this.results.size > 50) this.results.delete(this.results.keys().next().value!);
          if (account.state === "pending") await this.discard(account.id);
          else await this.accept(this.accounts.get(account.id)!, snapshot ?? { state: "unavailable" });
        }
      }, false);
    }).catch(() => this.exclusive(async () => {
      this.jobs.delete(account.id);
      const current = this.accounts.get(account.id);
      try {
        if (current?.state === "pending") await this.discard(account.id);
        else if (current) await this.observe(account.id, { state: "unavailable" });
      } catch { console.error("Account sign-in state could not be saved"); }
    }, false)).finally(() => { if (this.pending.get(account.id) === finished) this.pending.delete(account.id); });
    this.pending.set(account.id, finished);
    return capture;
  }

  private duplicateCandidates(account: AccountRecord) {
    const driver = this.registry.get(account.id)?.driverKind;
    return this.accounts.list().filter((row) => row.id !== account.id && row.driverKind === driver
      && row.state === "ready" && !this.accounts.drains[row.id]);
  }

  private async duplicateProbes(account: AccountRecord) {
    return new Map(await Promise.all(this.duplicateCandidates(account).map(async (row) => [
      row.id, await this.registry.get(row.id)?.snapshot({ refresh: true }).catch(() => undefined),
    ] as const)));
  }

  private async duplicate(account: AccountRecord, snapshot: ProviderSnapshot, snapshots?: Map<string, ProviderSnapshot | undefined>) {
    const rows = this.duplicateCandidates(account);
    const saved = rows.find((row) => snapshot.accountIdentity && this.accounts.get(row.id)?.identity === snapshot.accountIdentity);
    if (saved) return saved.id;
    const probes = snapshots ?? await this.duplicateProbes(account);
    const email = snapshot.account?.trim().toLowerCase();
    for (const row of rows) {
      const other = probes.get(row.id);
      if (other?.authenticated !== true) continue;
      const identity = other.accountIdentity ?? this.accounts.get(row.id)?.identity;
      if ((snapshot.accountIdentity && identity === snapshot.accountIdentity) || (email && other.account?.trim().toLowerCase() === email)) return row.id;
    }
  }

  private async accept(account: AccountRecord, snapshot: ProviderSnapshot, force = false) {
    if (snapshot.authenticated !== false && !(snapshot.authenticated === true && snapshot.accountIdentity)) {
      if (account.state === "ready") this.retry(account);
      return;
    }
    this.clearRetry(account.id);
    if (force && snapshot.authenticated === true && this.registry.get(account.id)?.driverKind === "codex") clearCodexPromo(account.home);
    if (force || snapshot.authenticated !== true || !snapshot.accountIdentity || snapshot.accountIdentity !== account.identity) this.hooks.invalidate(account.id);
    const next = await this.accounts.identify(account.id, snapshot.authenticated === true ? snapshot.accountIdentity : undefined, force);
    if (snapshot.authenticated !== true) await this.accounts.stop(account.id);
    if (next.generation !== account.generation || snapshot.authenticated !== true) await this.hooks.reload();
    this.registry.blockAccount(account.id, snapshot.authenticated !== true);
    this.hooks.changed?.(snapshot.authenticated === true ? account.id : undefined);
  }

  private promoHome(id: string) {
    const live = this.registry.get(id);
    return live?.driverKind === "codex" ? this.accounts.get(id)?.home ?? baseAccount(id, "codex", live.loginConfig?.().env ?? process.env).home : undefined;
  }

  private async discard(id: string) {
    this.clearRetry(id);
    this.hooks.invalidate(id);
    await this.accounts.retire(id);
    await this.hooks.reload();
    this.registry.blockAccount(id, false);
  }

  private mains() {
    const rows = this.accounts.list();
    return new Map(rows.filter((row) => row.existing).map((row) => {
      const id = this.accounts.defaultFor(row.of) ?? row.of;
      return [row.of, { engine: row.driverKind === "codex" ? "codex" as const : "claude" as const, id, generation: rows.find((entry) => entry.id === id)?.generation ?? 0 }];
    }));
  }

  private reportMains(before: ReturnType<AccountLifecycle["mains"]>) {
    for (const [base, to] of this.mains()) {
      const from = before.get(base);
      if (!from || (from.id === to.id && from.generation === to.generation)) continue;
      try {
        this.hooks.onMainChanged!({ base, engine: to.engine, from: { id: from.id, generation: from.generation }, to: { id: to.id, generation: to.generation }, seq: ++mainSeq });
      } catch { console.error("Main change could not be reported"); }
    }
  }

  private exclusive<T>(run: () => Promise<T>, checkConfig = true): Promise<T> {
    this.mutations += 1;
    const pending = this.queue.then(async () => {
      if (checkConfig && this.hooks.configBusy?.()) throw new AccountError("Provider settings are being updated");
      const before = this.hooks.onMainChanged && this.mains();
      try { return await run(); }
      finally { if (before) this.reportMains(before); }
    }).finally(() => {
      this.mutations -= 1;
      this.hooks.changed?.();
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
