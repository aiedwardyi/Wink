import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { AccountContext } from "./account-policy.ts";
import type { InstanceConfigMap } from "./contracts.ts";

export const MAX_ENGINE_ACCOUNTS = 8;
const ACCOUNT_ID = /^acct_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isInstanceId(value: string): boolean {
  return /^[\w.-]{1,128}$/.test(value) && !["constructor", "prototype", "__proto__", ".", ".."].includes(value.toLowerCase());
}
const recordSchema = z.object({
  id: z.string().regex(ACCOUNT_ID), of: z.string().refine(isInstanceId),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["pending", "ready", "stopped"]), identity: z.string().min(1).max(256).optional(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), accounts: z.array(recordSchema), retired: z.array(z.string().regex(ACCOUNT_ID)) }).strict();
type SavedAccount = z.infer<typeof recordSchema>;
type State = z.infer<typeof stateSchema>;
export interface AccountRecord extends AccountContext {
  readonly state: SavedAccount["state"];
  readonly identity?: string;
}

export class AccountError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

function plainDirectory(path: string, create: boolean) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) {
    throw new AccountError("Account home must not use a link or alias");
  }
}

export class AccountService {
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
      throw new AccountError("Cannot load accounts.json; account state is unavailable", 503);
    }
    try {
      this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      this.validate(this.state);
      if (this.state.accounts.length) {
        plainDirectory(this.root, false);
        for (const row of this.state.accounts) {
          plainDirectory(this.home(row.id), false);
          if (this.base(row.of).driver === "codex") plainDirectory(join(this.home(row.id), "state"), false);
        }
      }
      this.publish();
    } catch {
      throw new AccountError("Cannot load accounts.json; account state is corrupt or unsafe", 503);
    }
  }

  get snapshot(): readonly AccountRecord[] { return this.records; }
  get(id: string): AccountRecord | undefined { return this.records.find((row) => row.id === id); }

  list() {
    return Object.entries(this.bases()).filter(([, entry]) => entry.enabled !== false && ["claudeAgent", "codex"].includes(entry.driver))
      .flatMap(([of, entry]) => [
        { id: of, of, driverKind: entry.driver, generation: 0, existing: true, state: "ready" as const },
        ...this.records.filter((row) => row.of === of).map((row) => ({ id: row.id, of, driverKind: entry.driver, generation: row.generation, existing: false, state: row.state })),
      ]);
  }

  add(of: string): Promise<AccountRecord> {
    return this.change(() => {
      const base = this.base(of);
      const fleet = this.bases();
      const count = Object.values(fleet).filter((entry) => entry.enabled !== false && entry.driver === base.driver).length
        + this.state.accounts.filter((entry) => this.base(entry.of).driver === base.driver).length;
      if (count >= MAX_ENGINE_ACCOUNTS) throw new AccountError(`At most ${MAX_ENGINE_ACCOUNTS} accounts per engine, including the existing sign-in`);
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
      this.commit({ ...this.state, accounts: this.state.accounts.filter((row) => row.id !== id), retired: [...this.state.retired, id] });
    });
  }

  validateBases() { this.validate(this.state); }

  private require(id: string): AccountRecord {
    const row = this.get(id);
    if (!row) throw new AccountError("Unknown account", 404);
    return row;
  }
  private base(id: string) {
    const bases = this.bases();
    if (!isInstanceId(id) || !Object.hasOwn(bases, id) || bases[id].enabled === false || !["claudeAgent", "codex"].includes(bases[id].driver)) {
      throw new AccountError("Account base must be an enabled Claude or Codex instance", 400);
    }
    return bases[id];
  }
  private home(id: string) {
    const home = resolve(this.root, id);
    if (!ACCOUNT_ID.test(id) || relative(resolve(this.root), home) !== id) throw new AccountError("Unsafe account home");
    return home;
  }
  private validate(state: State) {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    const bases = this.bases();
    for (const entry of Object.values(bases)) if (entry.enabled !== false && ["claudeAgent", "codex"].includes(entry.driver)) counts.set(entry.driver, (counts.get(entry.driver) ?? 0) + 1);
    for (const id of [...state.retired, ...state.accounts.map((row) => row.id)]) {
      if (seen.has(id) || Object.hasOwn(bases, id)) throw new AccountError("Duplicate account id");
      seen.add(id);
    }
    for (const row of state.accounts) {
      const driver = this.base(row.of).driver;
      counts.set(driver, (counts.get(driver) ?? 0) + 1);
      this.home(row.id);
    }
    if ([...counts.values()].some((count) => count > MAX_ENGINE_ACCOUNTS)) throw new AccountError(`At most ${MAX_ENGINE_ACCOUNTS} accounts per engine`);
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
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => {});
    return pending;
  }
}
