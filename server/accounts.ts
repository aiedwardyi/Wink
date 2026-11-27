import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { AccountContext } from "./account-policy.ts";
import type { InstanceConfigMap, ProviderSnapshot } from "./contracts.ts";

export const ACCOUNT_DRIVERS: readonly string[] = ["claudeAgent", "codex", "grokAgent"];
const ACCOUNT_ID = /^acct_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isInstanceId(value: string): boolean {
  return /^[\w.-]{1,128}$/.test(value) && !["constructor", "prototype", "__proto__", ".", ".."].includes(value.toLowerCase());
}
const recordSchema = z.object({
  id: z.string().regex(ACCOUNT_ID), of: z.string().refine(isInstanceId),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["pending", "ready", "stopped"]), identity: z.string().min(1).max(256).optional(),
}).strict();
const drainSchema = z.object({ destinationId: z.string().refine(isInstanceId), phase: z.enum(["draining", "logout", "signed-out", "failed"]) }).strict();
const stateSchema = z.object({
  version: z.literal(1), accounts: z.array(recordSchema), retired: z.array(z.string().regex(ACCOUNT_ID)),
  defaults: z.record(z.string().refine(isInstanceId), z.string().refine(isInstanceId)).optional(),
  drains: z.record(z.string().refine(isInstanceId), drainSchema).optional(),
  // Bases the user signed out; while another account of the engine is listed, Usage and Connections leave them out.
  signedOut: z.array(z.string().refine(isInstanceId)).optional(),
}).strict();
export type AccountDrain = z.infer<typeof drainSchema>;
type SavedAccount = z.infer<typeof recordSchema>;
type State = z.infer<typeof stateSchema>;
export interface AccountRecord extends AccountContext {
  readonly state: SavedAccount["state"];
  readonly identity?: string;
}

export class AccountError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly bot?: string;
  constructor(message: string, status = 409, code?: string, bot?: string) { super(message); this.status = status; this.code = code; this.bot = bot; }
}

function plainDirectory(path: string, create: boolean) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const canonical = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(realpathSync(path)) !== canonical(join(realpathSync(dirname(path)), basename(path)))) {
    throw new AccountError("Account home must not use a link or alias");
  }
}

export const MISSING_HOME: ProviderSnapshot = Object.freeze({ state: "available", authenticated: false, accountAuthenticated: false });

// A saved home that went missing reads as signed out until Sign In creates it again (AccountService.openHome).
// Only the home itself counts: when it exists, the provider's own auth check answers.
export function missingAccountHome(account: AccountContext): boolean {
  try { return ACCOUNT_ID.test(account.id) && !lstatSync(account.home, { throwIfNoEntry: false }); } catch { return false; }
}

export class AccountService {
  readonly error?: string;
  private state: State = { version: 1, accounts: [], retired: [] };
  private records: readonly AccountRecord[] = Object.freeze([]);
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly root: string;
  private readonly dataDir: string;
  private readonly bases: () => InstanceConfigMap;

  constructor(dataDir: string, bases: () => InstanceConfigMap) {
    this.dataDir = dataDir;
    this.bases = bases;
    this.file = join(dataDir, "accounts.json");
    this.root = join(dataDir, "accounts");
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      this.error = "Cannot load accounts.json; accounts are off because account state is unavailable";
      return;
    }
    try {
      this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.validate(this.state);
      const present = (path: string) => lstatSync(path, { throwIfNoEntry: false });
      if (this.state.accounts.length && present(this.root)) {
        plainDirectory(this.root, false);
        for (const row of this.state.accounts) {
          const home = this.home(row.id);
          if (present(home)) plainDirectory(home, false);
          if (this.base(row.of).driver === "codex" && present(join(home, "state"))) plainDirectory(join(home, "state"), false);
        }
      }
      this.publish();
    } catch {
      this.state = { version: 1, accounts: [], retired: [] };
      this.error = "Cannot load accounts.json; accounts are off because account state is corrupt or unsafe, or its base engine is unavailable";
    }
  }

  get snapshot(): readonly AccountRecord[] { return this.records; }
  get(id: string): AccountRecord | undefined { return this.records.find((row) => row.id === id); }
  defaultFor(of: string) {
    const id = this.state.defaults && Object.hasOwn(this.state.defaults, of) ? this.state.defaults[of] : undefined;
    return id !== of ? id : undefined;
  }
  isDefault(id: string) {
    const of = this.get(id)?.of ?? id;
    return (this.defaultFor(of) ?? of) === id;
  }
  get drains(): Readonly<Record<string, AccountDrain>> { return this.state.drains ?? {}; }

  setDefault(of: string, accountId: string): Promise<void> {
    return this.change(() => {
      this.base(of);
      const account = this.get(accountId);
      if (this.drains[accountId] || (accountId !== of && (account?.of !== of || account.state !== "ready"))) {
        throw new AccountError("This account is unavailable or draining. Sign in again in Settings > Connections", 409, "main-unavailable");
      }
      if (accountId === of && !this.defaultFor(of)) return;
      const defaults = { ...this.state.defaults };
      if (accountId === of) delete defaults[of];
      else defaults[of] = accountId;
      this.commit({ ...this.state, defaults });
    });
  }

  drain(id: string, destinationId: string, phase: AccountDrain["phase"] = "draining"): Promise<void> {
    return this.change(() => {
      if (!isInstanceId(id) || !isInstanceId(destinationId) || id === destinationId) throw new AccountError("A different destination account id is required", 400);
      this.commit({ ...this.state,
        accounts: this.state.accounts.map((row) => row.id === id ? { ...row, state: "stopped" } : row),
        drains: { ...this.state.drains, [id]: { destinationId, phase } },
      });
    });
  }

  clearDrain(id: string): Promise<void> {
    return this.change(() => {
      const drains = { ...this.state.drains };
      delete drains[id];
      this.commit({ ...this.state, drains });
    });
  }

  finishDrain(id: string, destination: { of: string; accountId: string }, check: () => void = () => {}): Promise<void> {
    return this.change(() => {
      if (this.drains[id]?.phase !== "signed-out") throw new AccountError("Account sign-out is not confirmed");
      check();
      const defaults = { ...this.state.defaults };
      if ((this.defaultFor(destination.of) ?? destination.of) === id) {
        if (destination.accountId === destination.of) delete defaults[destination.of];
        else defaults[destination.of] = destination.accountId;
      }
      const drains = { ...this.state.drains };
      delete drains[id];
      this.commit({ ...this.marked(id, true), defaults, drains,
        accounts: this.state.accounts.filter((row) => row.id !== id),
        retired: this.get(id) ? [...this.state.retired, id] : this.state.retired,
      });
    });
  }

  list(): Array<{ id: string; of: string; driverKind: string; generation: number; existing: boolean; state: SavedAccount["state"]; error?: string; userSignedOut?: true }> {
    if (this.error) return [{ id: "accounts", of: "accounts", driverKind: "accounts", generation: 0, existing: false, state: "stopped", error: this.error }];
    return Object.entries(this.bases()).filter(([, entry]) => entry.enabled !== false && ACCOUNT_DRIVERS.includes(entry.driver))
      .flatMap(([of, entry]) => {
        const base: ReturnType<AccountService["list"]>[number] = { id: of, of, driverKind: entry.driver, generation: 0, existing: true, state: "ready" };
        if (this.state.signedOut?.includes(of)) base.userSignedOut = true;
        return [base, ...this.records.filter((row) => row.of === of).map((row) => ({ id: row.id, of, driverKind: entry.driver, generation: row.generation, existing: false, state: row.state }))];
      });
  }

  /** Any enabled engine signs in from its base; only ACCOUNT_DRIVERS also add accounts. */
  isBase(id: string) {
    const bases = this.bases();
    return isInstanceId(id) && Object.hasOwn(bases, id) && bases[id].enabled !== false;
  }

  add(of: string): Promise<AccountRecord> {
    return this.change(() => {
      const base = this.base(of);
      const fleet = this.bases();
      let id: string;
      do { id = `acct_${randomUUID()}`; } while (Object.hasOwn(fleet, id) || this.state.retired.includes(id) || this.get(id));
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      plainDirectory(this.root, true);
      const home = this.home(id);
      plainDirectory(home, true);
      if (base.driver === "codex") plainDirectory(join(home, "state"), true);
      const row: SavedAccount = { id, of, generation: 1, state: "pending" };
      this.commit({ ...this.state, accounts: [...this.state.accounts, row] });
      return this.get(id)!;
    });
  }

  identify(id: string, identity: string | undefined, force = false): Promise<AccountRecord> {
    return this.change(() => {
      const row = this.require(id);
      if (!force && row.state === "ready" && identity && row.identity === identity) return row;
      const generation = force || row.identity !== identity || !identity ? row.generation + 1 : row.generation;
      if (!Number.isSafeInteger(generation)) throw new AccountError("Account generation exhausted");
      this.commit({ ...this.state, accounts: this.state.accounts.map((entry) => entry.id === id ? { ...entry, generation, state: "ready", identity } : entry) });
      return this.get(id)!;
    });
  }

  stop(id: string): Promise<void> {
    return this.change(() => {
      this.require(id);
      this.commit({ ...this.state, accounts: this.state.accounts.map((row) => row.id === id ? { ...row, state: "stopped" } : row) });
    });
  }

  retire(id: string): Promise<void> {
    return this.change(() => {
      this.require(id);
      const defaults = Object.fromEntries(Object.entries(this.state.defaults ?? {}).filter(([, accountId]) => accountId !== id));
      this.commit({ ...this.state, defaults, accounts: this.state.accounts.filter((row) => row.id !== id), retired: [...this.state.retired, id] });
    });
  }

  /** A base the user signed out, or signed back in; any other id is left alone. */
  markSignedOut(id: string, signedOut: boolean): Promise<void> {
    if (this.error) return Promise.resolve();
    return this.change(() => {
      const next = this.marked(id, signedOut);
      if (next !== this.state) this.commit(next);
    });
  }

  // The only path that brings a missing saved home back: Sign In on an account still in the store.
  openHome(id: string) {
    const row = this.require(id);
    for (const path of [this.root, row.home, ...this.base(row.of).driver === "codex" ? [join(row.home, "state")] : []]) {
      plainDirectory(path, !lstatSync(path, { throwIfNoEntry: false }));
    }
  }

  validateBases(bases = this.bases()) { if (!this.error) this.validate(this.state, bases); }

  private marked(id: string, signedOut: boolean): State {
    const bases = this.bases();
    const marks = this.state.signedOut ?? [];
    if (this.get(id) || !Object.hasOwn(bases, id) || !ACCOUNT_DRIVERS.includes(bases[id].driver) || marks.includes(id) === signedOut) return this.state;
    const next = signedOut ? [...marks, id] : marks.filter((mark) => mark !== id);
    const state: State = { ...this.state, signedOut: next };
    if (!next.length) delete state.signedOut;
    return state;
  }

  private require(id: string): AccountRecord {
    const row = this.get(id);
    if (!row) throw new AccountError("Unknown account", 404);
    return row;
  }
  private base(id: string, bases = this.bases()) {
    if (!isInstanceId(id) || !Object.hasOwn(bases, id) || bases[id].enabled === false || !ACCOUNT_DRIVERS.includes(bases[id].driver)) {
      throw new AccountError("Account base must be an enabled Claude, Codex or Grok instance", 400);
    }
    return bases[id];
  }
  private home(id: string) {
    const home = resolve(this.root, id);
    if (!ACCOUNT_ID.test(id) || relative(resolve(this.root), home) !== id) throw new AccountError("Unsafe account home");
    return home;
  }
  private validate(state: State, bases = this.bases()) {
    const seen = new Set<string>();
    for (const id of [...state.retired, ...state.accounts.map((row) => row.id)]) {
      if (seen.has(id) || Object.hasOwn(bases, id)) throw new AccountError("Duplicate account id");
      seen.add(id);
    }
    for (const row of state.accounts) {
      this.base(row.of, bases);
      this.home(row.id);
    }
    for (const [of, accountId] of Object.entries(state.defaults ?? {})) {
      this.base(of, bases);
      if (accountId !== of && !state.accounts.some((row) => row.id === accountId && row.of === of)) throw new AccountError("Invalid default account");
    }
  }
  private commit(next: State) {
    this.validate(next);
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    this.state = next;
    this.publish();
  }
  private publish() {
    this.records = Object.freeze(this.state.accounts.map((row) => Object.freeze({ ...row, home: this.home(row.id) })));
  }
  private change<T>(run: () => T): Promise<T> {
    const pending = this.queue.then(() => {
      if (this.error) throw new AccountError(this.error, 503);
      return run();
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
