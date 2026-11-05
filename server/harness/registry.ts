// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { applyCredentialAllowlist } from "../config.ts";
import { findCliCandidates, refreshPathCache, splitCliString } from "../env-path.ts";
import { clearVersionCache, cliRevision } from "../procs.ts";
import { accountLaunch, type AccountContext } from "../account-policy.ts";
import { EngineLogin } from "../engine-login.ts";
import { withWslProbeSnapshot } from "../wsl-gate.ts";
import { warmPool as sharedWarmPool, type WarmPool } from "../drivers/warm-pool.ts";
import { retiredEngineLabel } from "../../shared/model-selection.ts";
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  InstanceId,
  ModelCatalog,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  /** Raw `config.cli` from disk — an override exists only if this is set. */
  cli: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

const MODEL_REFRESH_TTL_MS = 5_000;
const PROBE_REVISION = 2;

/** The part of a describe() row that costs process launches. */
interface Probe {
  snapshot: ProviderSnapshot;
  cliCandidates: string[];
  models?: ModelCatalog;
}

const savedProbeSchema = z.object({
  key: z.string(),
  snapshot: z.object({
    state: z.enum(["available", "unavailable"]), reason: z.string().optional(),
    authenticated: z.boolean().optional(), authChecked: z.boolean().optional(), account: z.string().optional(), version: z.string().nullable().optional(),
    billing: z.enum(["metered", "subscription"]).optional(),
  }),
  cliCandidates: z.array(z.string()),
  models: z.object({
    default: z.string(),
    options: z.array(z.object({
      id: z.string(), label: z.string(), custom: z.boolean().optional(),
      loaded: z.boolean().optional(), contextWindow: z.number().optional(),
    })),
  }),
});

export interface ProviderRegistryOptions {
  now?: () => number;
  modelRefreshTtlMs?: number;
  cacheDir?: string;
  warmPool?: WarmPool;
}

/** The `cli` field off a driver's default config, when it has one — the
 * placeholder an override input shows when nothing is set. */
function cliDefaultOf(driver: AnyProviderDriver | undefined): string | undefined {
  if (!driver) return undefined;
  try {
    const cfg = driver.defaultConfig() as { cli?: unknown };
    return typeof cfg?.cli === "string" ? cfg.cli : undefined;
  } catch {
    return undefined;
  }
}

/** Raw `config.cli` straight from disk — shadow snapshots can't decode, so
 * this is the only faithful way to echo back what was configured. */
function cliOfRaw(raw: unknown): string | undefined {
  const cli = (raw as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" && cli ? cli : undefined;
}

export class ProviderRegistry {
  readonly logins = new EngineLogin();
  private signingOut = new Set<string>();
  private accounts = new Map<string, AccountContext>();
  private blockedAccounts = new Set<string>();
  private accountIdentity?: (id: string, snapshot: ProviderSnapshot) => Promise<void>;
  private environmentByInstance = new Map<InstanceId, Record<string, string>>();
  private byId = new Map<InstanceId, RegistryEntry>();
  /** decoded per-instance `cli` overrides, for describe() — drivers spawn
   * from their own config; this map only reports what was configured */
  private cliByInstance = new Map<InstanceId, string>();
  private modelRefreshAt = new Map<InstanceId, number>();
  private modelRefreshInFlight = new Map<InstanceId, Promise<void>>();
  private probed = new Map<InstanceId, Probe>();
  private probing = new Map<InstanceId, Promise<Probe>>();
  private helperWork = new Map<InstanceId, number>();
  private tracked = new WeakSet<ProviderInstance>();
  private driversByKind: Map<string, AnyProviderDriver>;
  private readonly now: () => number;
  private readonly modelRefreshTtlMs: number;
  private readonly cacheDir: string | undefined;
  private cacheKeys = new Map<InstanceId, string>();
  private probeVersion = 0;
  private savedVersion = 0;
  private readonly warmPool: WarmPool;
  private identityHolds = new Map<InstanceId, { release: () => void; seq: number }>();
  private holdSeq = 0;
  private incarnations = new Map<InstanceId, string>();
  private incarnationSeq = 0;

  constructor(drivers: readonly AnyProviderDriver[], options: ProviderRegistryOptions = {}) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
    this.now = options.now ?? Date.now;
    this.modelRefreshTtlMs = options.modelRefreshTtlMs ?? MODEL_REFRESH_TTL_MS;
    this.cacheDir = options.cacheDir;
    this.warmPool = options.warmPool ?? sharedWarmPool;
  }

  async load(configs: InstanceConfigMap) {
    let saved: Record<string, unknown> = {};
    if (this.cacheDir) {
      try { saved = JSON.parse(readFileSync(join(this.cacheDir, "provider-probes.json"), "utf8")); } catch {}
    }
    const loaded = await Promise.all(Object.entries(configs).map(async ([instanceId, entry]) => {
      this.environmentByInstance.set(instanceId, entry.environment ?? {});
      if (entry.account) this.accounts.set(instanceId, entry.account);
      else this.accounts.delete(instanceId);
      const driver = this.driversByKind.get(entry.driver);
      if (!driver) {
        return {
          entry: {
            instanceId,
            shadow: {
              instanceId,
              driverKind: entry.driver,
              displayName: entry.displayName,
              cli: cliOfRaw(entry.config),
              shadow: true,
              reason: `unknown driver "${entry.driver}": kept as configured, unavailable here`,
            },
          },
        } satisfies { entry: RegistryEntry; rawCli?: string };
      }
      const rawCli = cliOfRaw(entry.config);
      try {
        const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
        // Override detection is on the RAW config, never the decoded one:
        // decodeConfig fills in the driver default ("claude", "codex", …),
        // so reading `cli` there would flag every instance as overridden.
        const live = await driver.create({
          instanceId,
          displayName: entry.displayName ?? driver.metadata.displayName,
          environment: entry.environment ?? {},
          enabled: entry.enabled ?? true,
          config,
          ...(entry.account ? { account: entry.account } : {}),
        });
        return { entry: { instanceId, live }, rawCli } satisfies { entry: RegistryEntry; rawCli?: string };
      } catch (e) {
        return {
          entry: {
            instanceId,
            shadow: {
              instanceId,
              driverKind: entry.driver,
              displayName: entry.displayName ?? driver.metadata.displayName,
              cli: cliOfRaw(entry.config),
              shadow: true,
              reason: e instanceof Error ? e.message : String(e),
            },
          },
          rawCli,
        } satisfies { entry: RegistryEntry; rawCli?: string };
      }
    }));
    for (const result of loaded) {
      void this.logins.cancel(result.entry.instanceId);
      this.logins.clear(result.entry.instanceId);
      this.forget(result.entry.instanceId);
      if (result.rawCli) this.cliByInstance.set(result.entry.instanceId, result.rawCli);
      else this.cliByInstance.delete(result.entry.instanceId);
      this.retire(result.entry.instanceId);
      if (result.entry.live) this.incarnations.set(result.entry.instanceId, `${result.entry.instanceId}#${++this.incarnationSeq}`);
      this.byId.set(result.entry.instanceId, result.entry);
      result.entry.live?.setAccountBlocked?.(this.blockedAccounts.has(result.entry.instanceId));
      const live = result.entry.live;
      if (live) this.trackWork(live);
      const driver = live && this.driversByKind.get(live.driverKind);
      if (driver && this.cacheDir) {
        const key = createHash("sha256").update(JSON.stringify([
          PROBE_REVISION, process.platform, configs[result.entry.instanceId], driver.defaultConfig(), driver.models,
          cliRevision(result.rawCli ?? cliDefaultOf(driver) ?? ""),
        ])).digest("hex");
        this.cacheKeys.set(result.entry.instanceId, key);
        const probe = savedProbeSchema.safeParse(saved?.[result.entry.instanceId]);
        if (!this.accounts.has(result.entry.instanceId) && probe.success && probe.data.key === key) this.probed.set(result.entry.instanceId, probe.data);
      }
      if (live?.modelsReady) {
        const ready = live.modelsReady
          .then(() => {
            if (this.byId.get(result.entry.instanceId)?.live === live) {
              this.modelRefreshAt.set(result.entry.instanceId, this.now());
            }
          })
          .catch(() => {
            if (this.byId.get(result.entry.instanceId)?.live === live) {
              this.modelRefreshAt.set(result.entry.instanceId, this.now());
            }
          })
          .finally(() => {
            if (this.modelRefreshInFlight.get(result.entry.instanceId) === ready) {
              this.modelRefreshInFlight.delete(result.entry.instanceId);
            }
          });
        this.modelRefreshAt.delete(result.entry.instanceId);
        this.modelRefreshInFlight.set(result.entry.instanceId, ready);
      } else if (live?.refreshModels) this.modelRefreshAt.set(result.entry.instanceId, this.now());
      else {
        this.modelRefreshAt.delete(result.entry.instanceId);
        this.modelRefreshInFlight.delete(result.entry.instanceId);
      }
    }
    if (this.cacheDir) this.savedVersion = this.probeVersion;
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  private trackWork(instance: ProviderInstance) {
    if (this.tracked.has(instance)) return;
    this.tracked.add(instance);
    const id = instance.instanceId;
    for (const key of ["generateText", "reviewPermission", "prepare", "snapshot"] as const) {
      const method = instance[key];
      if (!method) continue;
      Object.assign(instance, { [key]: async (...args: unknown[]) => {
        if (key !== "snapshot" && this.accountBlocked(id)) throw new Error("Account authentication is unavailable");
        this.helperWork.set(id, (this.helperWork.get(id) ?? 0) + 1);
        try { return await Reflect.apply(method, instance, args); }
        finally {
          const count = (this.helperWork.get(id) ?? 1) - 1;
          if (count) this.helperWork.set(id, count);
          else this.helperWork.delete(id);
        }
      } });
    }
  }

  onAccountIdentity(listener: (id: string, snapshot: ProviderSnapshot) => Promise<void>) { this.accountIdentity = listener; }
  blockAccount(id: string, blocked: boolean) {
    if (blocked) this.blockedAccounts.add(id);
    else this.blockedAccounts.delete(id);
    this.get(id)?.setAccountBlocked?.(blocked);
  }
  accountBlocked(id: string) { return this.blockedAccounts.has(id); }
  async retryAccount(id: string) {
    const entry = this.byId.get(id);
    if (entry?.live?.account) await (this.probing.get(id) ?? this.startProbe(entry, this.candidateScan(), { refresh: true }, true));
  }
  accountAvailable(id: string) {
    const snapshot = this.probed.get(id)?.snapshot;
    return Boolean(this.get(id)?.enabled) && !this.accountBlocked(id) && snapshot?.state !== "unavailable" && snapshot?.authenticated !== false;
  }
  accountBusy(id: string) { return this.probing.has(id) || this.modelRefreshInFlight.has(id) || this.helperWork.has(id) || this.logins.state(id) === "pending" || this.get(id)?.accountBusy?.() === true; }
  invalidateAccount(id: string) { this.holdIdentity(id, "account"); this.get(id)?.invalidateAccount?.(); this.forget(id); }

  /** Warm helpers for this instance stay unadoptable until a later probe settles who is signed in. */
  private holdIdentity(id: InstanceId, reason: string) {
    const release = this.warmPool.barrier({ instanceId: id }, reason);
    this.identityHolds.get(id)?.release();
    this.identityHolds.set(id, { release, seq: ++this.holdSeq });
    return this.holdSeq;
  }

  private settleIdentity(id: InstanceId, since = this.holdSeq) {
    const hold = this.identityHolds.get(id);
    if (!hold || hold.seq > since || this.logins.state(id) === "pending") return;
    hold.release();
    this.identityHolds.delete(id);
  }

  signIn(instanceId: InstanceId) {
    const entry = this.byId.get(instanceId);
    const kind = entry?.live?.driverKind ?? entry?.shadow?.driverKind;
    const driver = kind ? this.driversByKind.get(kind) : undefined;
    const command = driver?.install?.signInCommand;
    return command ? { driverKind: driver!.driverKind, command } : null;
  }

  install(instanceId: InstanceId) {
    const entry = this.byId.get(instanceId);
    const kind = entry?.live?.driverKind ?? entry?.shadow?.driverKind;
    const driver = kind ? this.driversByKind.get(kind) : undefined;
    const install = driver?.install;
    const command = install?.command?.[process.platform as "win32" | "darwin" | "linux"];
    if (command) this.holdIdentity(instanceId, "install");
    return command ? { driverKind: driver!.driverKind, command, needsNode: Boolean(install?.needsNode), signInCommand: install?.signInCommand } : null;
  }

  private loginConfig(instanceId: InstanceId) {
    const live = this.get(instanceId);
    const driver = live && this.driversByKind.get(live.driverKind);
    const resolved = live?.loginConfig?.();
    const cli = resolved?.cli ?? this.cliByInstance.get(instanceId) ?? cliDefaultOf(driver || undefined);
    const env = resolved?.env ?? { ...process.env, ...this.environmentByInstance.get(instanceId) };
    if (!resolved) applyCredentialAllowlist(env);
    const account = this.accounts.get(instanceId);
    const merged = { ...env, ...driver?.install?.login?.env };
    return live && driver && cli ? {
      engine: driver.driverKind, cli, install: driver.install,
      env: account ? accountLaunch(account, driver.driverKind, [], merged).env : merged,
      account,
    } : null;
  }

  async startSignIn(instanceId: InstanceId, device = false) {
    const config = this.loginConfig(instanceId);
    if (!config || this.signingOut.has(instanceId)) return null;
    this.holdIdentity(instanceId, "sign-in");
    if (config.engine === "antigravityAgent" && !device) return this.logins.waitExternal(instanceId);
    const login = config.install?.login;
    const args = device ? login?.deviceArgs : login?.args;
    if (!args) return null;
    const capture = await this.logins.start(instanceId, config.cli, args, config.env, login?.authHosts, { scope: config.engine, account: config.account });
    return login?.deviceArgs ? capture : { ...(capture.url ? { url: capture.url } : {}), ...(capture.error ? { error: capture.error } : {}),
      ...(config.account && config.engine === "claudeAgent" && capture.inputGeneration ? { inputGeneration: capture.inputGeneration } : {}),
    };
  }

  async cancelSignIn(instanceId: InstanceId) {
    const config = this.loginConfig(instanceId);
    if (!config) return false;
    if (this.signingOut.has(instanceId)) return true;
    await this.logins.cancel(instanceId);
    return true;
  }

  async signOut(instanceId: InstanceId) {
    const config = this.loginConfig(instanceId);
    if (!config?.install?.logout) return null;
    if (this.signingOut.has(instanceId)) return false;
    this.signingOut.add(instanceId);
    const since = this.holdIdentity(instanceId, "sign-out");
    try {
      await this.logins.cancel(instanceId);
      await this.logins.start(instanceId, config.cli, config.install.logout, config.env, [], { scope: config.engine, account: config.account });
      await this.logins.wait(instanceId);
      let success = this.logins.state(instanceId) === "complete";
      if (success || this.accounts.has(instanceId)) {
        if (success) this.logins.clear(instanceId);
        const previous = this.probed.get(instanceId);
        const live = this.get(instanceId);
        if (live) {
          const snapshot = await live.snapshot({ refresh: true });
          success = success && (this.accounts.has(instanceId) ? snapshot.accountAuthenticated === false : snapshot.authenticated === false);
          if (previous && this.get(instanceId) === live) this.probed.set(instanceId, { ...previous, snapshot });
          this.probeVersion += 1;
        }
      }
      if (success) this.settleIdentity(instanceId, since);
      return success;
    } finally {
      this.signingOut.delete(instanceId);
    }
  }

  async refreshLogins() {
    await Promise.all(this.entries().map(async (entry) => {
      const live = entry.live;
      if (!live || live.account || this.accountBlocked(entry.instanceId) || this.signingOut.has(entry.instanceId) || !this.logins.needsRefresh(entry.instanceId)) return;
      const previous = this.probed.get(entry.instanceId);
      if (!previous) return;
      const generation = this.logins.generation(entry.instanceId);
      let since = this.holdIdentity(entry.instanceId, "refresh");
      const snapshot = await live.snapshot({ refresh: true });
      if (this.signingOut.has(entry.instanceId) || this.logins.generation(entry.instanceId) !== generation || !this.logins.needsRefresh(entry.instanceId)) return;
      this.probed.set(entry.instanceId, { ...previous, snapshot });
      this.probeVersion += 1;
      if (snapshot.authenticated) {
        const newer = (this.identityHolds.get(entry.instanceId)?.seq ?? since) > since;
        const complete = this.holdIdentity(entry.instanceId, "sign-in complete");
        if (!newer) since = complete;
        this.logins.complete(entry.instanceId);
      }
      this.logins.acknowledge(entry.instanceId, snapshot.authenticated === true);
      this.settleIdentity(entry.instanceId, since);
    }));
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** `Captured.incarnation` for this instance's warm leases; a replacement or removal invalidates the old one's. */
  incarnation(instanceId: InstanceId): string | undefined { return this.incarnations.get(instanceId); }

  private retire(instanceId: InstanceId) {
    const incarnation = this.incarnations.get(instanceId);
    if (incarnation === undefined) return;
    this.incarnations.delete(instanceId);
    this.warmPool.invalidate({ instanceId, incarnation }, "reload");
  }

  remove(instanceId: InstanceId): ProviderInstance | null {
    const live = this.get(instanceId);
    this.retire(instanceId);
    void this.logins.cancel(instanceId);
    this.logins.clear(instanceId);
    this.byId.delete(instanceId);
    this.cliByInstance.delete(instanceId);
    this.environmentByInstance.delete(instanceId);
    this.accounts.delete(instanceId);
    this.blockedAccounts.delete(instanceId);
    this.modelRefreshAt.delete(instanceId);
    this.modelRefreshInFlight.delete(instanceId);
    this.forget(instanceId);
    return live;
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async describe(opts?: { rescan?: boolean; refresh?: boolean }) {
    if (opts?.rescan) clearVersionCache();
    const candidatesFor = this.candidateScan();
    const probe = async () => {
      const pending = [];
      for (const entry of this.entries()) {
        if (this.cacheDir) await new Promise<void>((resolve) => setImmediate(resolve));
        pending.push(this.startProbe(entry, candidatesFor, opts).then((probe) => this.row(entry, probe)));
      }
      const rows = await Promise.all(pending);
      this.saveProbes();
      return this.currentAccountRows(rows);
    };
    return this.prepareProbes(probe);
  }

  /** describe() rows from the last completed probe; only instances added or changed since are probed. */
  async describeCached() {
    await this.refreshLogins();
    const read = async () => {
      const candidatesFor = this.candidateScan();
      const rows = await Promise.all(
        this.entries().map(async (entry) => this.row(entry, this.probed.get(entry.instanceId) ??
          await (this.probing.get(entry.instanceId) ?? this.startProbe(entry, candidatesFor)))),
      );
      this.saveProbes();
      return this.currentAccountRows(rows);
    };
    return this.entries().some((entry) => !this.probed.has(entry.instanceId) && !this.probing.has(entry.instanceId))
      ? this.prepareProbes(read) : read();
  }

  /** describe() rows for instances with a saved probe; probes nothing. */
  describeSaved() {
    return this.entries().flatMap((entry) => {
      const probe = this.probed.get(entry.instanceId);
      return probe ? [this.row(entry, probe)] : [];
    });
  }

  private async currentAccountRows(rows: ReturnType<ProviderRegistry["row"]>[]) {
    const current = await Promise.all(rows.map(async (row) => {
      for (let attempt = 0; "accountGeneration" in row && row.accountGeneration !== undefined && this.accounts.get(row.instanceId)?.generation !== row.accountGeneration; attempt++) {
        const entry = this.byId.get(row.instanceId);
        if (!entry || attempt > 0 || entry.live?.account?.generation !== this.accounts.get(row.instanceId)?.generation) return [];
        const probe = this.probed.get(row.instanceId) ?? await (this.probing.get(row.instanceId) ?? this.startProbe(entry, this.candidateScan()));
        row = this.row(entry, probe);
      }
      return [row];
    }));
    return current.flat();
  }

  private async prepareProbes<T>(probe: () => Promise<T>): Promise<T> {
    const names = this.entries().flatMap((entry) => {
      const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
      return [cliDefaultOf(driver), this.cliByInstance.get(entry.instanceId)].flatMap((cli) => cli ? [splitCliString(cli)[0]] : []);
    });
    if (this.cacheDir && names.length) {
      await refreshPathCache([...names, "node.exe", "wsl"]);
      return withWslProbeSnapshot(probe);
    }
    return probe();
  }

  private saveProbes() {
    if (!this.cacheDir || this.savedVersion === this.probeVersion) return;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const saved = Object.fromEntries([...this.probed].flatMap(([id, probe]) => {
        const key = this.cacheKeys.get(id);
        const snapshot = { ...probe.snapshot };
        delete snapshot.accountIdentity;
        delete snapshot.accountAuthenticated;
        return key && probe.models ? [[id, { key, ...probe, snapshot }]] : [];
      }));
      writeFileAtomic(join(this.cacheDir, "provider-probes.json"), JSON.stringify(saved), { mode: 0o600 });
      this.savedVersion = this.probeVersion;
    } catch {}
  }

  // Multiple instances may share a driver. Scan each default binary once
  // per response instead of repeating filesystem work for every row.
  private candidateScan() {
    const candidatesByName = new Map<string, string[]>();
    return (driver: AnyProviderDriver | undefined): string[] => {
      const name = cliDefaultOf(driver);
      if (!name) return [];
      const cached = candidatesByName.get(name);
      if (cached) return cached;
      const found = findCliCandidates(name);
      candidatesByName.set(name, found);
      return found;
    };
  }

  private startProbe(
    entry: RegistryEntry,
    candidatesFor: (driver: AnyProviderDriver | undefined) => string[],
    opts?: { rescan?: boolean; refresh?: boolean },
    retryAccount = false,
  ): Promise<Probe> {
    const id = entry.instanceId;
    const since = this.holdSeq;
    if (this.accountBlocked(id) && !retryAccount) return this.probing.get(id) ?? Promise.resolve(this.probed.get(id) ?? { snapshot: { state: "unavailable" }, cliCandidates: [] });
    const pending: Promise<Probe> = this.probe(entry, candidatesFor, opts).then(async (probe) => {
      if (this.byId.get(id) === entry && this.probing.get(id) === pending) {
        this.probed.set(id, probe);
        // Identity observation must not count its own completed probe as live work.
        this.probing.delete(id);
        this.probeVersion += 1;
        if (entry.live?.account) {
          try { await this.accountIdentity?.(id, probe.snapshot); }
          catch (error) {
            const failed = { ...probe, snapshot: { state: "unavailable" as const, reason: error instanceof Error ? error.message : String(error) } };
            if (this.byId.get(id) === entry && this.probed.get(id) === probe) {
              this.probed.set(id, failed);
              this.probeVersion += 1;
            }
            return failed;
          }
        }
        if (probe.snapshot.state === "available" && !this.signingOut.has(id)) this.settleIdentity(id, since);
      }
      return probe;
    });
    this.probing.set(id, pending);
    return pending;
  }

  private forget(instanceId: InstanceId) {
    this.probed.delete(instanceId);
    this.probing.delete(instanceId);
    this.cacheKeys.delete(instanceId);
    this.probeVersion += 1;
  }

  private async probe(
    entry: RegistryEntry,
    candidatesFor: (driver: AnyProviderDriver | undefined) => string[],
    opts?: { rescan?: boolean; refresh?: boolean },
  ): Promise<Probe> {
    const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
    if (entry.shadow) {
      return {
        snapshot: { state: "unavailable", reason: entry.shadow.reason },
        // a shadow is exactly the "your CLI is broken, pick another"
        // case where the detected-path dropdown matters most
        cliCandidates: candidatesFor(driver),
      };
    }
    const inst = entry.live;
    let snapshot: ProviderSnapshot;
    try {
      const discovery = this.modelRefreshInFlight.get(inst.instanceId);
      if (discovery) await discovery;
      const lastRefresh = this.modelRefreshAt.get(inst.instanceId) ?? 0;
      // Creation may have resolved a stale cached CLI path; this probe runs after a fresh PATH scan.
      const freshPath = opts?.refresh || opts?.rescan;
      if (inst.refreshModels && (freshPath || this.now() - lastRefresh >= this.modelRefreshTtlMs)) {
        const inFlight = this.modelRefreshInFlight.get(inst.instanceId);
        if (inFlight) await inFlight;
        else {
          const refresh = (async () => {
            try {
              await inst.refreshModels!();
            } finally {
              if (this.byId.get(inst.instanceId)?.live === inst) {
                this.modelRefreshAt.set(inst.instanceId, this.now());
              }
            }
          })();
          this.modelRefreshInFlight.set(inst.instanceId, refresh);
          try {
            await refresh;
          } finally {
            if (this.modelRefreshInFlight.get(inst.instanceId) === refresh) this.modelRefreshInFlight.delete(inst.instanceId);
          }
        }
      }
      snapshot = await inst.snapshot(opts);
    } catch (e) {
      snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
    }
    if (snapshot.state === "available") snapshot = { ...snapshot, authChecked: true };
    return {
      snapshot,
      // every copy of the driver's default binary on the augmented PATH -
      // the dropdown's "detected" entries. Snapshotted per probe so a
      // newly installed CLI shows up on the next refresh.
      cliCandidates: candidatesFor(driver),
      models: this.cacheDir ? structuredClone(inst.models) : undefined,
    };
  }

  private row(entry: RegistryEntry, probe: Probe) {
    const driver = this.driversByKind.get(entry.shadow?.driverKind ?? entry.live!.driverKind);
    const snapshot = { ...probe.snapshot };
    delete snapshot.accountIdentity;
    delete snapshot.accountAuthenticated;
    if (entry.shadow) {
      return {
        instanceId: entry.instanceId,
        loginState: undefined,
        loginCapture: undefined,
        loginError: undefined,
        driverKind: entry.shadow.driverKind,
        displayName: entry.shadow.displayName ?? retiredEngineLabel(entry.shadow.driverKind) ?? entry.shadow.driverKind,
        snapshot,
        models: { default: "", options: [] },
        capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
        // an unknown driver has no driver record, hence no install path
        access: driver?.metadata.access ?? "subscription",
        install: driver?.install,
        cli: entry.shadow.cli,
        cliDefault: cliDefaultOf(driver),
        cliCandidates: probe.cliCandidates,
      };
    }
    const inst = entry.live;
    return {
      instanceId: inst.instanceId,
      ...(inst.account ? { accountOf: inst.account.of, accountGeneration: inst.account.generation, canRefreshUsage: true } : {}),
      ...(this.logins.capture(inst.instanceId).error ? { loginError: this.logins.capture(inst.instanceId).error } : {}),
      loginState: this.signingOut.has(inst.instanceId) ? "cancelled" : this.logins.state(inst.instanceId),
      loginCapture: this.signingOut.has(inst.instanceId) ? {}
        : driver?.install?.login?.deviceArgs ? this.logins.capture(inst.instanceId)
        : { url: this.logins.capture(inst.instanceId).url,
          ...(inst.account && inst.driverKind === "claudeAgent" && this.logins.capture(inst.instanceId).inputGeneration
            ? { inputGeneration: this.logins.capture(inst.instanceId).inputGeneration } : {}),
        },
      driverKind: inst.driverKind,
      displayName: inst.displayName ?? inst.driverKind,
      snapshot,
      models: probe.models ?? inst.models,
      capabilities: {
        computerMcp: inst.adapter.capabilities.computerMcp === true,
        agentsMcp: inst.adapter.capabilities.agentsMcp === true,
        composioMcp: inst.adapter.capabilities.composioMcp === true,
        phoneMcp: inst.adapter.capabilities.phoneMcp === true,
        browserMcp: inst.adapter.capabilities.browserMcp === true,
        images: inst.adapter.capabilities.images === true,
        effortLevels: inst.adapter.capabilities.effortLevels,
        queueing: inst.adapter.capabilities.queueing === true,
        localComputerMcp: inst.adapter.capabilities.localComputerMcp === true,
        askApproval: inst.adapter.capabilities.askApproval !== false,
        approvalReview: inst.reviewPermission !== undefined,
        rateLimits: inst.adapter.capabilities.rateLimits === true,
      },
      access: driver?.metadata.access ?? "subscription",
      install: driver?.install,
      cli: this.cliByInstance.get(inst.instanceId),
      cliDefault: cliDefaultOf(driver),
      cliCandidates: probe.cliCandidates,
    };
  }

  async disposeAll() {
    await this.logins.dispose();
    this.environmentByInstance.clear();
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    await this.warmPool.closeAll("exit", { final: true });
    this.byId.clear();
    this.cliByInstance.clear();
    this.modelRefreshAt.clear();
    this.modelRefreshInFlight.clear();
    this.probed.clear();
    this.probing.clear();
    this.cacheKeys.clear();
  }
}
