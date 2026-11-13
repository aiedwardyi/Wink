// MSP driver runtime: Meta `muse serve` speaks MSP (session/start,
// turn/start, view notifications), not ACP, so the ACP core cannot drive
// it — this is the minimal session/turn runtime for that host. Phase 1:
// spawn, initialize, session start/resume, one text turn, interrupt,
// approvals + userInput answers. Effort/model switching and account usage
// windows build on the same channel. Never extend acp/core.ts.
import { createHash } from "node:crypto";
import os, { homedir } from "node:os";

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ModelCatalog,
  PrepareTurn,
  ProviderDriver,
  ProviderErrorCode,
  ProviderInstance,
  ProviderSnapshot,
  RequestOutcome,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { applyCredentialAllowlist } from "../../config.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath, toWslPath } from "../../env-path.ts";
import { execCli, killCliTree, setCliPriority, spawnCli } from "../../procs.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { isWslCommand, withWslProbeReason, wslBlockedReason, wslProbeAllowed } from "../../wsl-gate.ts";
import { startTurnTimer } from "../../turn-timing.ts";
import type { CliText, CliTextContext } from "../cli-text.ts";
import { warmFingerprint, warmToolsKey, type WarmEligibilityInput } from "../acp/warm-eligibility.ts";
import { finishNative } from "../native.ts";
import { experimentalAgents } from "../tool-catalog.ts";
import { museUsageReport } from "../rate-limits.ts";
import { systemLedger } from "../system-ledger.ts";
import { warmPool as sharedWarmPool, type Captured, type Lease, type WarmChild, type WarmPool } from "../warm-pool.ts";
import { createMspChannel, uuidv7, type MspChannel } from "./protocol.ts";

const INIT_TIMEOUT = 20_000;
const SESSION_TIMEOUT = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
const ASK_TIMEOUT_MS = 15 * 60_000;
const HANDSHAKE = "__handshake__";

const DENY_TIMEOUT_NOTE =
  "Wink: nobody answered this permission request in time. Skip this action and finish what you can without it.";

/** Resumed-session poison: provider-private history the active route cannot
 * replay, including encrypted reasoning from a switched model. A fresh
 * session recovers; anything else fails exactly as before. */
const INCOMPATIBLE_HISTORY =
  /provider-private history is incompatible|reasoning\s+[`'"]?encrypted_content[`'"]?\s+was not issued to this caller/i;

export interface MspMuseConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

export interface MspSupport {
  driverKind: string;
  displayName: string;
  /** Static catalog; model/list stays the live source of truth (see muse.ts). */
  models: ModelCatalog;
  /** Effort tiers the host accepts; absent = the selector stays hidden. */
  effortLevels?: readonly EffortLevel[];
  defaultCli: string;
  nativeSource: string;
  loginNote: string;
  install?: EngineInstall;
  credentialEnv?: readonly string[];
  transformEnv?(env: Record<string, string | undefined>, config: MspMuseConfig): void;
  isAuthenticated(env: Record<string, string | undefined>, config: MspMuseConfig): boolean | Promise<boolean>;
  account?(env: Record<string, string | undefined>): string | undefined;
  requireAuthenticationBeforeSpawn?: boolean;
  /** Map an MSP turn error to a provider code (auth shapes). */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** win32 only: wrapper + resolver shared with the ACP muse driver. */
  wslProbeWrapper?: (cli: string) => string | null;
  wslResolveCli?: (cli: string, probeEnv: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Tests inject their own; idle session hosts follow its TTL. */
  warmPool?: WarmPool;
  /** Extra `serve` argv for this CLI's `--version` line. */
  serveArgs?(version: string | null, wsl: boolean): string[];
  /** One-shot text for summaries, outside any MSP session. */
  text?(ctx: CliTextContext): CliText;
}

const decodeConfig = (raw: unknown): MspMuseConfig => {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "",
    fullAuto: o.fullAuto === true,
    workspace: typeof o.workspace === "string" ? o.workspace : undefined,
  };
};

interface ApprovalChoice {
  choiceId?: string;
  decision?: string;
  label?: string;
}

interface AskBase {
  requestId: string;
  finish: (behavior: "allow" | "deny" | "answer", source: AskSource, message?: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ApprovalAsk extends AskBase {
  kind: "approval";
  approvalId: string;
  requirementId: unknown;
  choices: ApprovalChoice[];
}

interface UserInputAsk extends AskBase {
  kind: "userInput";
  userInputId: string;
  questions: Array<{ id?: string }>;
}

type AskSource = "user" | "timeout" | "system";

type Ask = ApprovalAsk | UserInputAsk;

/** Item ids the host opened, for routing item/delta to a text stream. */
type ItemKinds = Map<string, string>;

const textStreamFor = (kinds: ItemKinds, itemId: string, field: unknown) => {
  const kind = kinds.get(itemId);
  // Reasoning streams its summary parts as "summary.<n>".
  if (kind === "reasoning" && /^summary\.\d+$/.test(String(field))) return "reasoning_text" as const;
  if (field !== undefined && field !== null && field !== "text") return null;
  if (kind === "reasoning") return "reasoning_text" as const;
  // agentMessage streams here; unknown kinds stream generically (SS4.10)
  // except tool calls, whose output is fetched via item/readOutput, not text.
  if (kind !== undefined && kind !== "agentMessage") return null;
  return "assistant_text" as const;
};

type MspIntegrations = NonNullable<SendTurnInput["integrations"]>;

/** One session MCP server, stdio arm of the schema's SessionMcpServerConfig.
 * `transport` is required: the union is closed, so an arm without it fails
 * session/start decode. */
export interface MspMcpServer {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Behind the `wsl` wrapper the muse host is a Linux process, so a server
 * command it spawns must be named in /mnt/c form.
 *
 * Args are deliberately NOT translated. The command is a Windows exe reached
 * through WSL interop, and interop hands argv over verbatim: a /mnt/c arg
 * arrives at node.exe as the nonexistent `C:\mnt\c\...` and the server dies
 * on spawn. Same for env: those values are read by the Windows child. */
export function translateMspServerForWsl(server: MspMcpServer): MspMcpServer {
  return { ...server, command: toWslPath(server.command) };
}

/** Every Orbit MCP server this turn mounts, in the MSP session-config shape.
 * Mirrors the ACP core's set so a Muse bot has the same hands as a Grok
 * Build one; `undefined` when the turn mounts nothing, so the `config` key
 * stays off the wire entirely. */
export function mspMcpServers(
  integrations: MspIntegrations | undefined,
  opts: { wsl: boolean },
): Record<string, MspMcpServer> | undefined {
  const servers: Record<string, MspMcpServer> = {};
  const add = (name: string, server: { command: string; args: string[]; env?: Record<string, string> }) => {
    const stdio: MspMcpServer = {
      transport: "stdio",
      command: server.command,
      args: server.args,
      env: server.env ?? {},
    };
    servers[name] = opts.wsl ? translateMspServerForWsl(stdio) : stdio;
  };
  if (integrations?.agents) add("agents", experimentalAgents(integrations.agents, true));
  if (integrations?.composio) add("composio", integrations.composio);
  if (integrations?.browser) add("browser", integrations.browser);
  if (integrations?.terminal) add("terminal", integrations.terminal);
  if (integrations?.phone) add("phone", integrations.phone);
  // The bot's computer, mounted exactly as acp/core.ts does it: a cloud box
  // goes through the REST adapter proxy, host and sandbox Cua connections
  // expose Cua Driver's own MCP server directly.
  if (integrations?.computer) {
    add("computer", {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: { ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(integrations.computer) },
    });
  } else if (integrations?.localComputer) {
    add("computer", integrations.localComputer);
  }
  return Object.keys(servers).length ? servers : undefined;
}

const initializeHost = async (channel: MspChannel) => {
  await channel.request(
    "initialize",
    {
      protocolVersion: 1,
      clientInfo: { name: "orbit", version: "1.0.8" },
      // Schema key is `capabilities`; the ACP-shaped
      // clientCapabilities rides along (tolerated live).
      // sessionMcp is a GRANTED capability: without it here the host
      // fails session/start with capabilityRequired the moment the
      // params carry any MCP server.
      capabilities: { userInputDialogs: false, requestedCapabilities: ["sessionMcp"] },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
    INIT_TIMEOUT,
  );
  channel.notify("initialized", {});
};

/** First approved-* choice for allow, first denied-* for deny, ends as fallback. */
const pickChoice = (choices: ApprovalChoice[], want: "allow" | "deny"): ApprovalChoice | null => {
  if (!choices.length) return null;
  const prefix = want === "allow" ? "approved" : "denied";
  return (
    choices.find((c) => typeof c.decision === "string" && c.decision.startsWith(prefix)) ??
    (want === "allow" ? choices[0] : choices[choices.length - 1])
  );
};

/** The host already settled this approval; a late decide is not a turn failure. */
const isSettledApprovalError = (err: unknown): boolean =>
  err instanceof Error && /(already resolved|is stale)/.test(err.message);

/** Muse took the decision (intake passed) but failed to ack it durably. */
const isDecideSettlementError = (err: unknown): boolean =>
  err instanceof Error && /approval decide settlement failed/.test(err.message);

export function createMspDriver(support: MspSupport): ProviderDriver<MspMuseConfig> {
  const DRIVER_KIND = support.driverKind;
  const withCli = (raw: unknown): MspMuseConfig => {
    const decoded = decodeConfig(raw);
    return { ...decoded, cli: decoded.cli || support.defaultCli };
  };

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig: withCli,
    defaultConfig: () => withCli({}),

    async create(input: DriverCreateInput<MspMuseConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const baseCli = config.cli || support.defaultCli;
      let wslCli: string | null = null;
      // Last real answer, replayed while the WSL gate is shut so a sleeping
      // WSL engine does not flap to "not found" on every passive refresh.
      let lastSnapshot: ProviderSnapshot | null = null;
      const effectiveCli = () => wslCli ?? baseCli;
      let cliVersion: string | null = null;
      const isWslCli = () => /^\s*wsl(\.exe)?(\s|$)/i.test(effectiveCli());
      const probe = (target: string, probeEnv: NodeJS.ProcessEnv): Promise<string | null> =>
        new Promise((resolve) => {
          if (isWslCommand(target) && !wslProbeAllowed()) return resolve(null);
          execCli(target, ["--version"], { timeout: 8000, env: probeEnv }, (err, stdout) => {
            if (!err) cliVersion = stdout.trim();
            resolve(err ? null : stdout.trim());
          });
        });
      // Same 3-step fallback as the ACP core: bare, wrapped, resolved — one
      // resolution steers snapshot probes and every turn alike.
      const resolveCli = async (probeEnv: NodeJS.ProcessEnv) => {
        const tried = new Set([baseCli]);
        if (await probe(baseCli, probeEnv)) {
          wslCli = null;
          return true;
        }
        if (process.platform === "win32") {
          const wrapped = support.wslProbeWrapper?.(baseCli) ?? null;
          if (wrapped && !tried.has(wrapped)) {
            tried.add(wrapped);
            if (await probe(wrapped, probeEnv)) {
              wslCli = wrapped;
              return true;
            }
          }
          if (!wslProbeAllowed()) return false;
          const resolved = await support.wslResolveCli?.(baseCli, probeEnv);
          if (resolved && !tried.has(resolved) && (await probe(resolved, probeEnv))) {
            wslCli = resolved;
            return true;
          }
        }
        return false;
      };
      // Turns and prepare share one successful resolution; snapshot()
      // re-probes and refreshes it, a miss is never remembered.
      let cliResolved: Promise<boolean> | null = null;
      const ensureCli = (probeEnv: NodeJS.ProcessEnv) => {
        cliResolved ??= resolveCli(probeEnv).then((ok) => {
          if (!ok) cliResolved = null;
          return ok;
        });
        return cliResolved;
      };
      const childEnv = () => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        applyCredentialAllowlist(env, [...(support.credentialEnv ?? [])]);
        support.transformEnv?.(env, config);
        return env;
      };

      const text = support.text?.({
        cli: async () => {
          if (!(await ensureCli(childEnv()))) throw new Error(`${support.displayName} CLI not found`);
          return effectiveCli();
        },
        env: childEnv,
      });

      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        turnId: string;
        interrupt: () => void;
        asks: Map<string, Ask>;
      }
      const active = new Map<string, Turn>();
      const children = new Set<ReturnType<typeof spawnCli>>();
      const systemHeld = systemLedger();

      // Idle hosts live in the warm pool. A session host keeps its session
      // across turns only while its sign-in is still the CLI's current one;
      // an unverified sign-in gets the initialize-only handshake host.
      interface Host extends WarmChild {
        child: ReturnType<typeof spawnCli>;
        channel: MspChannel;
        initialized: boolean;
        sessionId: string | null;
        model: string | null;
        resumedOk: boolean;
        fellBack: boolean;
        /** Sign-in hash at spawn, in memory only; never log it. */
        identity: string;
        lease?: Lease;
        /** The running turn's handlers, or the idle drop listener. */
        unbind: Array<() => void>;
        inUse: boolean;
        /** Set while a turn adopts it: closing its old lease must not kill it. */
        detached: boolean;
        exited: boolean;
        closed?: Promise<void>;
        ttl?: ReturnType<typeof setTimeout>;
        setupError?: unknown;
      }
      type Request = (method: string, params: unknown, timeoutMs: number) => Promise<any>;
      const incarnation = input.incarnation ?? newId();
      const pool = support.warmPool ?? sharedWarmPool;
      const hosts = new WeakMap<Lease, Host>();
      const preparing = new WeakMap<Lease, Promise<boolean>>();
      let disposed = false;
      let identity = "";
      // A take needs a sign-in check newer than the last prepare.
      let prepares = 0;
      let checked = 0;
      const keyFor = (threadId: string) => ({ engine: DRIVER_KIND, instanceId, threadId });
      const hashOf = (label: string | undefined) => (label ? createHash("sha256").update(label).digest("hex") : "");
      const readIdentity = () => hashOf(support.account?.(childEnv()));
      const generationNow = () => input.account?.generation ?? pool.generation(keyFor(""));
      const capture = (id = identity): Captured => ({ generation: generationNow(), incarnation, identity: id });
      // The last verified sign-in, for cachedCapture only; never feeds the take rule.
      let lastCapture: Captured | null = null;
      const remember = (seen: string) => {
        lastCapture = seen ? capture(seen) : null;
      };
      const eligibility = (
        shape: Pick<SendTurnInput, "threadId" | "model" | "cwd" | "integrations">,
        captured: Captured,
      ): WarmEligibilityInput => {
        const cwd = shape.cwd ?? config.workspace ?? homedir();
        return {
          threadId: shape.threadId,
          cwd,
          sessionCwd: isWslCli() ? toWslPath(cwd) : cwd,
          model: shape.model,
          // Effort travels per turn in turn/start.
          effort: undefined,
          fullAuto: config.fullAuto,
          identity: captured.identity,
          cli: effectiveCli(),
          argsKey: "serve",
          toolsKey: warmToolsKey(shape.integrations),
          generation: captured.generation,
        };
      };
      const handshakeFingerprint = () => JSON.stringify(["handshake", effectiveCli()]);
      const sessionConfigFor = (integrations: SendTurnInput["integrations"]) => {
        // Session MCP rides in the `config` extension object, never at the
        // top level: SessionStartParams has no `mcpServers` member, and the
        // decoder ignores unknown keys instead of rejecting them: a top-level
        // mount is silently dropped and every tool simply never appears.
        const mcpServers = mspMcpServers(integrations, { wsl: isWslCli() });
        return mcpServers ? { config: { mcpServers } } : {};
      };

      const closeHost = (host: Host): Promise<void> => {
        if (host.detached) return Promise.resolve();
        host.closed ??= (() => {
          clearTimeout(host.ttl);
          for (const off of host.unbind.splice(0)) off();
          host.channel.detach();
          try {
            killCliTree(host.child);
          } catch {
            // already gone
          }
          children.delete(host.child);
          return host.exited ? Promise.resolve() : new Promise<void>((resolve) => host.child.once("exit", () => resolve()));
        })();
        return host.closed;
      };
      const spawnHost = (cwd: string, env: Record<string, string | undefined>): Host => {
        const args = ["serve", ...(support.serveArgs?.(cliVersion, isWslCli()) ?? [])];
        const child = spawnCli(effectiveCli(), args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        children.add(child);
        const host: Host = {
          child,
          channel: createMspChannel(child),
          initialized: false,
          session: { kind: "argv" },
          sessionId: null,
          model: null,
          resumedOk: false,
          fellBack: false,
          identity: readIdentity(),
          unbind: [],
          inUse: false,
          detached: false,
          exited: false,
          alive: () =>
            !host.exited && child.exitCode === null && child.signalCode === null
            && !child.stdin?.destroyed && !child.stdout?.destroyed,
          close: () => closeHost(host),
        };
        child.once("exit", () => {
          host.exited = true;
          // A running turn settles its own exit.
          if (!host.inUse) host.lease?.release("exit");
        });
        return host;
      };
      const attachLease = (host: Host, lease: Lease) => {
        host.lease = lease;
        hosts.set(lease, host);
        lease.attach(host);
      };
      const idle = (host: Host) => {
        host.inUse = false;
        host.unbind.push(host.channel.onNotification((method) => console.debug(`${DRIVER_KIND}: idle host dropped ${method}`)));
      };
      /** Resume or start, then setModel: the one session setup prepare and turns share. */
      const openSession = async (
        host: Host,
        request: Request,
        shape: Pick<SendTurnInput, "resumeCursor" | "model">,
        sessionRoot: string,
        sessionConfig: object,
      ) => {
        const model = shape.model;
        const opened = (result: any) => {
          host.sessionId = typeof result?.session?.sessionId === "string" ? result.session.sessionId : null;
          host.model = typeof result?.session?.modelId === "string" ? result.session.modelId : null;
          if (!host.sessionId) throw new Error("session/start returned no sessionId");
        };
        if (typeof shape.resumeCursor === "string") {
          try {
            const resumed: any = await request(
              "session/resume",
              { commandId: uuidv7(), sessionId: shape.resumeCursor, ...sessionConfig },
              SESSION_TIMEOUT,
            );
            host.sessionId = typeof resumed?.session?.sessionId === "string" ? resumed.session.sessionId : shape.resumeCursor;
            host.model = typeof resumed?.session?.modelId === "string" ? resumed.session.modelId : null;
            host.resumedOk = true;
          } catch {
            // --no-session-log hosts reject resume (-32601): start fresh
            // and replay the fallback text instead of the transcript.
            opened(await request("session/start", { commandId: uuidv7(), workspaceRoot: sessionRoot, ...sessionConfig }, SESSION_TIMEOUT));
            host.fellBack = true;
          }
        } else {
          opened(await request(
            "session/start",
            { commandId: uuidv7(), workspaceRoot: sessionRoot, ...(model ? { modelId: model } : {}), ...sessionConfig },
            SESSION_TIMEOUT,
          ));
        }
        if (model && model !== host.model) {
          // Mid-session switch (cursor.ts configureSession is the ACP
          // twin): unlike cursor there is no argv pin to fall back on,
          // so a rejected switch fails the turn instead of silently
          // running the wrong model.
          try {
            await request("session/setModel", { commandId: uuidv7(), sessionId: host.sessionId, model: { modelId: model } }, SESSION_TIMEOUT);
          } catch (err) {
            throw new Error(
              `Muse rejected model "${model}" via session/setModel: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          host.model = model;
        }
      };
      /** One prepare per lease; a same-key prepare joins it and releases once if it fails. */
      const prepareLease = async (lease: Lease, cwd: string, setup?: (host: Host, request: Request) => Promise<void>) => {
        const joined = preparing.get(lease);
        if (joined) {
          if (!(await joined)) lease.release("prepare failed");
          return;
        }
        if (hosts.has(lease)) return;
        const run = (async () => {
          let host: Host;
          try {
            host = spawnHost(cwd, childEnv());
            if (lease.key.threadId === HANDSHAKE) setCliPriority(host.child, "low");
          } catch {
            lease.release("spawn failed");
            return false;
          }
          attachLease(host, lease);
          const request: Request = (method, params, timeoutMs) =>
            lease.signal.aborted || disposed
              ? Promise.reject(new Error("prepare aborted"))
              : host.channel.request(method, params, timeoutMs);
          try {
            await initializeHost(host.channel);
            host.initialized = true;
            await setup?.(host, request);
            if (lease.signal.aborted) return false;
            lease.ready();
            if (!host.inUse) idle(host);
            return !lease.signal.aborted;
          } catch {
            lease.release("prepare failed");
            return false;
          }
        })();
        preparing.set(lease, run);
        await run.finally(() => preparing.delete(lease));
      };
      const prepareHandshake = async () => {
        const lease = pool.reserve(keyFor(HANDSHAKE), handshakeFingerprint(), capture(""), "handshake");
        if (typeof lease === "string") return;
        await prepareLease(lease, config.workspace ?? homedir());
        const host = hosts.get(lease);
        if (host && !host.inUse && !host.ttl && !lease.signal.aborted) {
          host.ttl = setTimeout(() => {
            if (!host.inUse) lease.release("idle");
          }, pool.handshakeIdleMs());
          host.ttl.unref?.();
        }
      };
      const prepareSession = async (shape: PrepareTurn, captured: Captured) => {
        if (active.has(shape.threadId)) return;
        const lease = pool.reserve(keyFor(shape.threadId), warmFingerprint(eligibility(shape, captured)), captured, "speculative");
        if (typeof lease === "string") return;
        const cwd = shape.cwd ?? config.workspace ?? homedir();
        await prepareLease(lease, cwd, async (host, request) => {
          await openSession(host, request, shape, isWslCli() ? toWslPath(cwd) : cwd, sessionConfigFor(shape.integrations));
          // A fresh session cannot serve the asked-for cursor.
          if (host.fellBack) throw new Error("resume fell back to a fresh session");
          host.session = typeof shape.resumeCursor === "string" ? { kind: "loaded", id: host.sessionId! } : { kind: "fresh" };
          // Off the Send path: a method-not-found reply proves the host reads stdin.
          await request("orbit/ping", {}, 1_000).catch((err: unknown) => {
            if ((err as { code?: unknown })?.code !== -32601) throw err;
          });
        });
      };
      const smallerPc = () => os.totalmem() < 8 * 1024 ** 3 || os.cpus().length <= 4;

      const emit = (event: RuntimeEvent) => {
        finishNative(event);
        for (const l of [...listeners]) l(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        if (turn.integrations?.localComputer?.scope === "local-computer" && config.fullAuto) {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
  const turnTimer = startTurnTimer({
    threadId,
    engine: support.driverKind ?? "msp",
    model: turn.model,
    effort: turn.effort ?? null,
    systemPromptChars: typeof turn.system === "string" ? turn.system.length : 0,
  });
  turnTimer.mark("dispatch");
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv();
        const asks = new Map<string, Ask>();
        // Stop can land before the real interrupt is installed below; a
        // claimed or racing host dies at once and keeps nothing.
        let cancelled = false;
        let claimed: Lease | null = null;
        let racer: Host | null = null;
        let raced = false;
        const earlyInterrupt = () => {
          cancelled = true;
          claimed?.release("stopped");
          if (racer) void closeHost(racer);
        };
        active.set(threadId, { turnId, interrupt: earlyInterrupt, asks });
        try {
          if (support.requireAuthenticationBeforeSpawn && !(await withWslProbeReason("turn", () => support.isAuthenticated(env, config)))) {
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, signIn: true });
            active.delete(threadId);
            turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required" });
            return { turnId };
          }
          if (!(await withWslProbeReason("turn", () => ensureCli(env)))) {
            emit({ ...base(threadId, turnId), type: "turn.started" });
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: wslProbeAllowed("turn") ? `\`${effectiveCli()}\` CLI not found` : wslBlockedReason(support.displayName),
              setup: true,
            });
            active.delete(threadId);
            turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "unavailable" });
            return { turnId };
          }
          const seen = readIdentity();
          remember(seen);
          if (seen !== identity) {
            identity = seen;
            pool.invalidate({ instanceId, incarnation }, "identity changed");
          }
        } catch (err) {
          active.delete(threadId);
          throw err;
        }

        // Behind the wsl wrapper the host is a Linux process: Windows
        // paths never resolve there. Hoisted: poison recovery reuses it.
        const sessionRoot = isWslCli() ? toWslPath(cwd) : cwd;
        const sessionConfig = sessionConfigFor(turn.integrations);
        const captured = capture();
        const own = !cancelled && identity && checked === prepares
          ? pool.take(keyFor(threadId), warmFingerprint(eligibility(turn, captured)), captured, turn.resumeCursor)
          : "miss";
        if (own === "busy") {
          active.delete(threadId);
          throw new Error("a turn is already running on this thread");
        }
        const taken = cancelled ? "miss" : own !== "miss" ? own : pool.take(keyFor(HANDSHAKE), handshakeFingerprint(), capture(""), undefined);
        claimed = typeof taken === "object" ? ("hit" in taken ? taken.hit : taken.pending) : null;
        let host: Host | null = typeof taken === "object" && "hit" in taken ? (hosts.get(taken.hit) ?? null) : null;
        if (host && !host.alive()) {
          claimed!.release("dead");
          claimed = null;
          host = null;
        }
        if (host) {
          clearTimeout(host.ttl);
          for (const off of host.unbind.splice(0)) off();
          host.inUse = true;
        }
        emit({ ...base(threadId, turnId), type: "turn.started" });
        if (!host?.sessionId) emit({ ...base(threadId, turnId), type: "turn.stage", stage: "setup" });
        if (claimed && !host && !cancelled) {
          const pending = claimed;
          const adopt = (preparing.get(pending) ?? Promise.resolve(false)).then((ok) => {
            const prepared = ok && !pending.signal.aborted ? hosts.get(pending) : undefined;
            if (prepared) {
              clearTimeout(prepared.ttl);
              for (const off of prepared.unbind.splice(0)) off();
              prepared.inUse = true;
            }
            return prepared ?? null;
          });
          if (pending.key.threadId === HANDSHAKE || smallerPc()) host = await adopt;
          else {
            // Adopt or race: a slow prepare never makes the turn later than cold.
            racer = spawnHost(cwd, env);
            racer.inUse = true;
            const cold = racer;
            const coldReady = (async () => {
              await initializeHost(cold.channel);
              cold.initialized = true;
              await openSession(cold, (method, params, timeoutMs) => cold.channel.request(method, params, timeoutMs), turn, sessionRoot, sessionConfig);
              return cold;
            })().catch((err: unknown) => {
              cold.setupError = err;
              return null;
            });
            host = await new Promise<Host | null>((resolve) => {
              let left = 2;
              const done = (winner: Host | null) => {
                if (winner) resolve(winner);
                else if (--left === 0) resolve(null);
              };
              void adopt.then(done);
              void coldReady.then(done);
            }) ?? cold;
            raced = host === cold;
            if (raced) pending.release("lost the race");
            else void closeHost(cold);
            racer = null;
          }
          if (!host) {
            pending.release("prepare failed");
            claimed = null;
          }
        }
        if (cancelled) {
          if (host) void closeHost(host);
          claimed?.release("stopped");
          active.delete(threadId);
          turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled" });
          return { turnId };
        }
        const reused = !!host && !raced;
        const turnHost = host ?? spawnHost(cwd, env);
        turnHost.inUse = true;
        setCliPriority(turnHost.child, "normal");
        // The turn owns its lease and offers it back; an adopted handshake
        // lease is released without killing the host it hands over.
        let lease = turnHost.lease === claimed && claimed ? claimed : undefined;
        if (lease?.key.threadId === HANDSHAKE) {
          turnHost.detached = true;
          lease.release("adopted");
          turnHost.detached = false;
          turnHost.lease = undefined;
          lease = undefined;
        }
        claimed = null;
        const warmSession = reused && !!turnHost.sessionId;
        turnTimer.mark("spawnOrReuse");
        turnTimer.setMeta({ reusedHandshake: reused && !warmSession, reusedSession: warmSession });
        const channel = turnHost.channel;
        const state = {
          settled: false,
          mspTurnId: null as string | null,
          sessionId: null as string | null,
          model: null as string | null,
        };
        const kinds: ItemKinds = new Map();
        const openTools = new Set<string>();
        const buffers = new Map<string, string>();
        let latestUsageObservedAt: string | null = null;
        let completionPending = false;
        // Tagged events seen before the turn/start ack names our turn, in order.
        const held: Array<[string, unknown]> = [];
        let expectedCommand: string | null = null;
        let promptSent = false;
        let finishing = false;
        let interrupted = false;
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        let pendingText = "";
        // Poisoned-resume retry state (one retry max): recovered flips on the single retry.
        let recovered = false;
        // The system text this turn carried, and whether the host compacted it away.
        let systemSent: string | undefined;
        let compacted = false;
        const bound: Array<() => void> = [];

        const stop = () => {
          lease?.release("turn ended");
          void closeHost(turnHost);
        };
        function flushText() {
          if (!pendingText) return;
          const text = pendingText;
          pendingText = "";
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        }
        const completeTool = (itemId: string, ok: boolean) => {
          if (!openTools.delete(itemId)) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok });
        };
        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled) return;
          state.settled = true;
          if (state.sessionId && compacted) systemHeld.forget(state.sessionId);
          else if (state.sessionId && systemSent && ok && stopReason === null) systemHeld.record(state.sessionId, systemSent);
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const ask of [...asks.values()]) ask.finish("deny", "system");
          // The entry drops BEFORE turn.completed: the queue drain on that
          // event must see a free thread (adapter contract), and the kept
          // host must already be ready for the turn it sends.
          active.delete(threadId);
          const kept = ok && stopReason === null && retain();
          flushText();
          for (const itemId of openTools) completeTool(itemId, false);
          turnTimer.mark("turnDone");
    turnTimer.finish();
    emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason });
          if (!kept) stop();
        };
        /** Hands the host back with its session after a clean native completion. */
        const retain = (): boolean => {
          const sessionId = state.sessionId;
          if (interrupted || recovered || disposed || !sessionId || !turnHost.alive() || !turnHost.identity) return false;
          const seen = readIdentity();
          remember(seen);
          const now = capture(seen);
          if (seen !== turnHost.identity || now.generation !== captured.generation) return false;
          for (const off of bound.splice(0)) off();
          channel.onServerRequest(null);
          Object.assign(turnHost, { session: { kind: "loaded", id: sessionId }, sessionId, model: state.model, resumedOk: true, fellBack: false });
          identity = seen;
          checked = prepares;
          if (lease) {
            if (!pool.offer(lease, turnHost.session)) return false;
          } else {
            const reserve = () => pool.reserve(keyFor(threadId), warmFingerprint(eligibility(turn, now)), now, "speculative");
            let fresh = reserve();
            // Another host already idles under this key: this one replaces it.
            if (typeof fresh === "object" && (hosts.has(fresh) || preparing.has(fresh))) {
              fresh.release("replaced");
              fresh = reserve();
            }
            if (typeof fresh !== "object" || hosts.has(fresh) || preparing.has(fresh)) return false;
            attachLease(turnHost, fresh);
            fresh.ready();
            if (fresh.signal.aborted) return false;
            lease = fresh;
          }
          idle(turnHost);
          return true;
        };
        const fail = (message: string, signIn = false, stopReason: string | null = "rpc_error") => {
          emit({ ...base(threadId, turnId), type: "runtime.error", message, signIn: signIn || undefined });
          settle(false, stopReason);
        };
        const startTurnOn = async (targetSessionId: string, fullText: string) => {
          const commandId = uuidv7();
          expectedCommand = commandId;
          const request = channel.request(
            "turn/start",
            {
              commandId,
              sessionId: targetSessionId,
              input: [{ type: "text", text: fullText }],
              // Levels travel verbatim (max stays max, never ultra); none
              // and unset both omit the key so the CLI keeps its default.
              ...(turn.effort && turn.effort !== "none" ? { reasoningEffort: turn.effort } : undefined),
            },
            SESSION_TIMEOUT,
          );
          if (!promptSent) {
            promptSent = true;
            emit({ ...base(threadId, turnId), type: "turn.stage", stage: "prompt-sent" });
          }
          const ack: any = await request;
          if (ack?.status !== "accepted" || ack?.disposition !== "started") {
            throw new Error(`turn/start not started (status ${ack?.status}, disposition ${ack?.disposition})`);
          }
          state.mspTurnId = typeof ack?.turnId === "string" ? ack.turnId : commandId;
          for (const [method, params] of held.splice(0)) onNotification(method, params);
        };
        // A resumed session whose provider-private history the active route
        // cannot replay poisons the turn (and its Retry, which resumes the
        // same session). Recover once on a fresh session; false otherwise —
        // and false on any throw, so callers fail exactly as before.
        const recoverIncompatible = async (message: string): Promise<boolean> => {
          try {
            if (recovered || !turnHost.resumedOk) return false;
            if (!INCOMPATIBLE_HISTORY.test(message)) return false;
            if (typeof turn.resumeCursor !== "string") return false;
            recovered = true;
            const started: any = await channel.request(
              "session/start",
              {
                commandId: uuidv7(),
                workspaceRoot: sessionRoot,
                ...sessionConfig,
                ...(turn.model ? { modelId: turn.model } : {}),
              },
              SESSION_TIMEOUT,
            );
            const freshId = typeof started?.session?.sessionId === "string" ? started.session.sessionId : null;
            if (!freshId) return false;
            state.sessionId = freshId;
            state.mspTurnId = null;
            state.model = typeof started?.session?.modelId === "string" ? started.session.modelId : null;
            // Callers record the cursor from session.started: the fresh id
            // steers Retry onto the recovered session, not the poisoned one.
            emit({ ...base(threadId, turnId), type: "session.started", sessionId: freshId, model: state.model ?? turn.model ?? null });
            systemSent = turn.system;
            const retryText = turn.system
              ? `${turn.system}\n\n${turn.resumeFallback?.text ?? turn.text}`
              : (turn.resumeFallback?.text ?? turn.text);
            await startTurnOn(freshId, retryText);
            return true;
          } catch {
            return false;
          }
        };
        const onDelta = (streamKind: "assistant_text" | "reasoning_text", delta: string) => {
          if (!delta) return;
          // Reasoning only feeds the Thinking label, never the answer text.
          if (streamKind === "assistant_text") pendingText += delta;
          emit({ ...base(threadId, turnId), type: "content.delta", streamKind, delta });
        };
        const emitUsage = (payload: unknown) => {
          const report = museUsageReport(payload);
          if (!report) return;
          if (latestUsageObservedAt && Date.parse(report.observedAt) <= Date.parse(latestUsageObservedAt)) return;
          latestUsageObservedAt = report.observedAt;
          emit({
            ...base(threadId, turnId),
            type: "account.rate-limits.updated",
            observedAt: report.observedAt,
            windows: report.windows,
          });
        };
        const settleCompleted = async () => {
          // Muse updates its cached subscription snapshot at turn completion;
          // read it before the short-lived serve process is cleaned up.
          try {
            emitUsage(await channel.request("usage/read", undefined, 1_500));
          } catch {
            // A host without usage/read still completes the turn normally.
          }
          settle(true, null);
        };

        // Last decision per approval, replayed on each later stage.
        const decisions = new Map<string, { want: "allow" | "deny"; requirement: string }>();
        const decideApproval = async (
          ask: Pick<ApprovalAsk, "approvalId" | "requirementId" | "choices">,
          want: "allow" | "deny",
        ): Promise<boolean> => {
          const choice = pickChoice(ask.choices, want);
          if (!choice?.choiceId || state.sessionId === null) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no usable approval choice — denying instead of guessing`,
            });
            return false;
          }
          // Set before the request: the host announces the next stage before it acks this one.
          decisions.set(ask.approvalId, { want, requirement: JSON.stringify(ask.requirementId ?? null) });
          const decide = () =>
            channel.request(
              "approval/decide",
              {
                commandId: uuidv7(),
                sessionId: state.sessionId,
                approvalId: ask.approvalId,
                choiceId: choice.choiceId,
                requirementId: ask.requirementId,
              },
              SESSION_TIMEOUT,
            );
          try {
            await decide();
          } catch (err) {
            if (!isDecideSettlementError(err)) throw err;
            // Re-sync once: "already resolved" confirms the first decide landed,
            // success means it had not. Either way the tool is running.
            await decide().catch((retryErr) => {
              if (!isSettledApprovalError(retryErr) && !isDecideSettlementError(retryErr)) throw retryErr;
            });
          }
          return true;
        };

        const seenApprovals = new Set<string>();
        const openApproval = (params: any) => {
          const approvalId = typeof params?.approvalId === "string" ? params.approvalId : null;
          const choices = Array.isArray(params?.availableChoices) ? params.availableChoices : [];
          // Muse 1.3 sends approval/request and approval/requested for one approval.
          if (!approvalId || seenApprovals.has(approvalId)) return;
          seenApprovals.add(approvalId);
          const tool = String(params?.toolName ?? "tool").slice(0, 80);
          const summary = String(params?.rawArgs ?? params?.toolName ?? tool).slice(0, 200);
          if (config.fullAuto) {
            // No card: answer immediately with the allow choice, like the core.
            void decideApproval({ approvalId, requirementId: params?.currentRequirementId, choices }, "allow").catch(
              (err) => {
                if (!isSettledApprovalError(err)) fail(err instanceof Error ? err.message : String(err));
              },
            );
            return;
          }
          const requestId = newId();
          const ask: ApprovalAsk = {
            kind: "approval",
            requestId,
            approvalId,
            requirementId: params?.currentRequirementId,
            choices,
            finish: (behavior, source) => {
              if (!asks.delete(requestId)) return;
              clearTimeout(ask.timer);
              const want = behavior === "allow" ? "allow" : "deny";
              void decideApproval(ask, want)
                .then((decided) => {
                  emit({
                    ...base(threadId, turnId),
                    type: "request.resolved",
                    requestId,
                    behavior: decided && behavior === "allow" ? "allow" : "deny",
                    source: decided ? source : "system",
                  });
                })
                .catch((err) => {
                  // A deny already states the terminal outcome — the write
                  // will not run — so a failed deny settlement is
                  // bookkeeping, not news: settle the card as denied and stay
                  // quiet instead of failing the turn over the CLI's
                  // ledger/fence internals. The turn still lands on its own,
                  // and a failed allow decide fails exactly as before.
                  if (want === "deny") {
                    emit({
                      ...base(threadId, turnId),
                      type: "request.resolved",
                      requestId,
                      behavior: "deny",
                      source,
                    });
                    return;
                  }
                  if (isSettledApprovalError(err)) {
                    emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior: "deny", source: "system" });
                    return;
                  }
                  fail(err instanceof Error ? err.message : String(err));
                });
            },
            timer: setTimeout(() => {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
              asks.get(requestId)?.finish("deny", "timeout");
            }, ASK_TIMEOUT_MS),
          };
          ask.timer.unref?.();
          asks.set(requestId, ask);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            choices: choices.map((c: ApprovalChoice) => String(c?.label ?? "")).filter(Boolean),
          });
        };
        // Muse stages a shell approval per pipeline stage: approval/updated
        // moves currentRequirementId on, and the tool waits for every stage.
        const continueApproval = (params: any) => {
          const approvalId = typeof params?.approvalId === "string" ? params.approvalId : null;
          const prior = approvalId ? decisions.get(approvalId) : undefined;
          if (!approvalId || !prior || !params?.currentRequirementId) return;
          if (JSON.stringify(params.currentRequirementId) === prior.requirement) return;
          const choices = Array.isArray(params?.availableChoices) ? params.availableChoices : [];
          void decideApproval({ approvalId, requirementId: params.currentRequirementId, choices }, prior.want).catch(
            (err) => {
              if (prior.want === "allow" && !isSettledApprovalError(err)) {
                fail(err instanceof Error ? err.message : String(err));
              }
            },
          );
        };

        const openUserInput = (params: any) => {
          const userInputId = typeof params?.userInputId === "string" ? params.userInputId : null;
          const questions = Array.isArray(params?.questions) ? params.questions : [];
          if (!userInputId || !questions.length) return;
          const first = questions[0] ?? {};
          const requestId = newId();
          const ask: Ask = {
            kind: "userInput",
            requestId,
            userInputId,
            questions,
            finish: (behavior, source, message) => {
              if (!asks.delete(requestId)) return;
              clearTimeout(ask.timer);
              const done = (outcome: "answer" | "deny") => {
                emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior: outcome, source });
              };
              if (behavior === "answer") {
                const answers = questions
                  .filter((q: { id?: string }) => typeof q?.id === "string")
                  .map((q: { id?: string }) => ({ questionId: q.id, freeText: String(message ?? "").slice(0, 500) }));
                if (state.sessionId === null || !answers.length) {
                  done("deny");
                  return;
                }
                void channel
                  .request(
                    "userInput/answer",
                    { commandId: uuidv7(), sessionId: state.sessionId, userInputId, answers },
                    SESSION_TIMEOUT,
                  )
                  .then(() => done("answer"))
                  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
              } else {
                if (state.sessionId === null) {
                  done("deny");
                  return;
                }
                void channel
                  .request(
                    "userInput/cancel",
                    { commandId: uuidv7(), sessionId: state.sessionId, userInputId },
                    SESSION_TIMEOUT,
                  )
                  .then(() => done("deny"))
                  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
              }
            },
            timer: setTimeout(() => {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
              asks.get(requestId)?.finish("deny", "timeout");
            }, ASK_TIMEOUT_MS),
          };
          ask.timer.unref?.();
          asks.set(requestId, ask);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: String(params?.toolName ?? "tool").slice(0, 80),
            summary: String(first?.question ?? "input needed").slice(0, 200),
            choices: Array.isArray(first?.options) ? first.options.map((o: any) => String(o?.label ?? "")).filter(Boolean) : [],
          });
        };

        // A retained host serves many turns: events tagged for another turn
        // (a replayed or late one) never reach this one. Untagged events
        // cannot be told apart and still do.
        const tagOf = (p: any): string | undefined =>
          typeof p?.turnId === "string" ? p.turnId : (typeof p?.item?.turnId === "string" ? p.item.turnId : undefined);
        channel.onServerRequest((id, method, params) => {
          const tag = tagOf(params);
          if (state.mspTurnId !== null && tag !== undefined && tag !== state.mspTurnId) {
            // Ack stale presentation requests without surfacing an RPC error on the reused host.
            channel.respond(id, {});
            return {};
          }
          // The receipt acks presentation only; the decision travels as a
          // command (SS5.3.3). Answer it before opening the card.
          if (method === "approval/request") {
            channel.respond(id, {});
            openApproval(params);
            return {};
          }
          if (method === "userInput/request") {
            channel.respond(id, {});
            openUserInput(params);
            return {};
          }
          throw new Error(`method not found: ${method}`);
        });
        const onNotification = (method: string, params: any) => {
          if (state.settled) return;
          const p = (params ?? {}) as Record<string, any>;
          if (p.item?.kind === "compaction") compacted = true;
          const tag = tagOf(p);
          if (state.mspTurnId === null) {
            // Ack-before-id race: hold in order until the ack names our turn.
            if (held.length || (tag !== undefined && tag !== expectedCommand)) {
              held.push([method, params]);
              return;
            }
          } else if (tag !== undefined && tag !== state.mspTurnId) return;
          switch (method) {
            case "approval/requested":
              openApproval(p);
              break;
            case "approval/updated":
              continueApproval(p);
              break;
            case "userInput/requested":
              openUserInput(p);
              break;
            case "item/started": {
              const item = p.item;
              const itemId = item?.itemId ?? item?.id;
              if (typeof itemId !== "string" || typeof item?.kind !== "string") break;
              const seen = kinds.has(itemId);
              kinds.set(itemId, item.kind);
              if (item.kind === "toolCall" && !seen) {
                flushText();
                openTools.add(itemId);
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId,
                  title: typeof item.tool === "string" ? item.tool.slice(0, 80) : "tool",
                });
              }
              break;
            }
            case "item/delta": {
              if (typeof p.itemId === "string" && typeof p.delta === "string") {
                const stream = textStreamFor(kinds, p.itemId, p.field);
                if (stream) {
                  buffers.set(p.itemId, (buffers.get(p.itemId) ?? "") + p.delta);
                  onDelta(stream, p.delta);
                }
              }
              break;
            }
            case "item/completed": {
              const itemId = p.item?.itemId ?? p.item?.id;
              if (p.item?.kind === "toolCall" && typeof itemId === "string") {
                completeTool(itemId, p.item.status === "completed");
              }
              const item = p.item as { id?: string; kind?: string; text?: unknown } | undefined;
              if (item?.kind === "agentMessage") {
                const text = typeof item.text === "string"
                  ? item.text
                  : (typeof item.id === "string" ? (buffers.get(item.id) ?? "") : "");
                if (text) {
                  pendingText = "";
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
                }
              }
              break;
            }
            case "session/modelChanged": {
              const frame: unknown = p.session ?? {};
              const frameId = typeof frame === "object" && frame !== null && "sessionId" in frame
                ? frame.sessionId
                : undefined;
              const frameModel = typeof frame === "object" && frame !== null && "modelId" in frame
                ? frame.modelId
                : undefined;
              const changed = typeof p.modelId === "string" ? p.modelId : frameModel;
              if (typeof changed === "string" && (frameId === undefined || frameId === state.sessionId)) {
                state.model = changed;
              }
              break;
            }
            case "usage/changed": {
              emitUsage(p);
              break;
            }
            case "turn/foregroundCompleted": {
              // The answer is done; Muse keeps running background items
              // until turn/completed, which alone ends the turn.
              flushText();
              if (!finishing) {
                finishing = true;
                emit({ ...base(threadId, turnId), type: "turn.stage", stage: "finishing" });
              }
              break;
            }
            case "turn/completed": {
              const terminal = p.terminal as string | undefined;
              if (terminal === "completed") {
                if (!completionPending) {
                  completionPending = true;
                  void settleCompleted();
                }
              }
              else if (terminal === "cancelled") settle(true, "cancelled");
              else {
                const code = support.classifyError?.(p.error);
                const auth = code === "invalid_credentials" || code === "inactive_subscription";
                if (!auth) {
                  const message = p.error?.message ? String(p.error.message) : (typeof p.reason === "string" ? p.reason : "failed");
                  // Poisoned resume (failed completion): one fresh-session
                  // retry before failing exactly as before.
                  void recoverIncompatible(message).then((ok) => {
                    if (!ok && !state.settled) {
                      fail(message, false, typeof p.reason === "string" ? p.reason : "failed");
                    }
                  });
                  break;
                }
                fail(
                  p.error?.message ? String(p.error.message) : (typeof p.reason === "string" ? p.reason : "failed"),
                  auth,
                  auth ? "auth_required" : (typeof p.reason === "string" ? p.reason : "failed"),
                );
              }
              break;
            }
            default:
              break;
          }
        };
        // Bound before this turn's first write; retain() unbinds them.
        bound.push(channel.onNotification(onNotification));
        bound.push(channel.onExit(() => {
          if (!state.settled && !completionPending) fail(`${DRIVER_KIND} exited before the turn completed`, false, "exit_before_result");
        }));

        active.set(threadId, {
          turnId,
          interrupt: () => {
            interrupted = true;
            // No session yet (init in flight): nothing to interrupt, stop
            // like the ACP core does pre-prompt.
            if (!state.sessionId) {
              stop();
              settle(true, "cancelled");
              return;
            }
            // Interrupt acceptance is not completion: the turn is over when
            // turn/completed arrives; the grace kill is the backstop.
            channel.notify("turn/interrupt", {
              commandId: uuidv7(),
              sessionId: state.sessionId,
              ...(state.mspTurnId ? { turnId: state.mspTurnId } : {}),
            });
            if (interruptTimer) return;
            interruptTimer = setTimeout(() => settle(true, "cancelled"), INTERRUPT_GRACE_MS);
            interruptTimer.unref?.();
          },
          asks,
        });

        void (async () => {
          try {
            if (turnHost.setupError) throw turnHost.setupError;
            if (!turnHost.initialized) {
              await initializeHost(channel);
              turnHost.initialized = true;
            }
            if (!turnHost.sessionId) {
              await openSession(turnHost, (method, params, timeoutMs) => channel.request(method, params, timeoutMs), turn, sessionRoot, sessionConfig);
            }
            const sessionId = turnHost.sessionId!;
            state.sessionId = sessionId;
            state.model = turnHost.model;
            const promptText = turnHost.fellBack ? (turn.resumeFallback?.text ?? turn.text) : turn.text;
            emit({ ...base(threadId, turnId), type: "session.started", sessionId, model: state.model ?? turn.model ?? null });
            turnTimer.mark("cliReady");
            // A session that already holds this exact system text gets only the turn text.
            const system = turn.system && (turnHost.fellBack || !systemHeld.holds(sessionId, turn.system)) ? turn.system : undefined;
            if (system) {
              systemHeld.forget(sessionId);
              systemSent = system;
            }
            const text = system ? `${system}\n\n${promptText}` : promptText;
            await startTurnOn(sessionId, text);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            state.sessionId ??= turnHost.sessionId;
            // Poisoned resume (turn/start rejected): one fresh-session retry
            // before failing exactly as before.
            if (!state.settled && !(await recoverIncompatible(message))) fail(message);
          }
        })();

        return { turnId };
      };

      const respondToRequest = async (
        threadId: string,
        requestId: string,
        decision: { behavior: "allow" | "deny" | "answer"; message?: string },
      ): Promise<RequestOutcome> => {
        const ask = active.get(threadId)?.asks.get(requestId);
        if (!ask) return "unavailable"; // settled, timed out, or turn gone
        if (ask.kind === "approval") {
          if (decision.behavior !== "allow") {
            ask.finish("deny", "user");
            return "rejected";
          }
          // The decide travels async; a rejection lands as request.resolved
          // deny/system, correcting this optimistic answer.
          ask.finish("allow", "user");
          return "allowed-once";
        }
        ask.finish(decision.behavior === "answer" ? "answer" : "deny", "user", decision.message);
        return decision.behavior === "answer" ? "answered" : "rejected";
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        loginConfig: () => ({ cli: effectiveCli(), env: childEnv() }),
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return support.models;
        },
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "in-session",
            rateLimits: true,
            askApproval: !config.fullAuto,
            effortLevels: support.effortLevels,
            agentsMcp: true,
            composioMcp: true,
            browserMcp: true,
            phoneMcp: true,
            computerMcp: true,
            // Host control needs interactive approvals, same rule as ACP.
            localComputerMcp: !config.fullAuto,
          },
          sendTurn,
          interruptTurn: async (threadId) => {
            active.get(threadId)?.interrupt();
          },
          respondToRequest,
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const turn of [...active.values()]) turn.interrupt();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        snapshot: (opts?: { rescan?: boolean }): Promise<ProviderSnapshot> =>
          withWslProbeReason(opts?.rescan ? "rescan" : "passive", async (): Promise<ProviderSnapshot> => {
            const env = childEnv();
            const gated = support.wslProbeWrapper !== undefined && !wslProbeAllowed();
            const resolved = await resolveCli(env);
            cliResolved = resolved ? Promise.resolve(true) : null;
            if (!resolved) {
              if (gated) return lastSnapshot ?? { state: "unavailable", reason: wslBlockedReason(support.displayName) };
              return { state: "unavailable", reason: `\`${effectiveCli()}\` CLI not found` };
            }
            const version = await probe(effectiveCli(), env);
            const authenticated = await support.isAuthenticated(env, config);
            const label = authenticated ? support.account?.(env) : undefined;
            remember(hashOf(label));
            const ready: ProviderSnapshot = { state: "available", version, authenticated, account: label };
            if (!gated) lastSnapshot = ready;
            return ready;
          }),
        generateText: text?.generateText,
        textModel: text?.textModel,
        textTimeoutMs: text?.textTimeoutMs,
        prepare: async (shape?: PrepareTurn) => {
          if (!input.enabled || disposed) return;
          if (shape && (active.has(shape.threadId) || (shape.integrations?.localComputer?.scope === "local-computer" && config.fullAuto))) return;
          const round = ++prepares;
          const env = childEnv();
          try {
            if (support.requireAuthenticationBeforeSpawn && !(await support.isAuthenticated(env, config))) {
              lastCapture = null;
              pool.invalidate({ instanceId, incarnation }, "signed out");
              return;
            }
            if (!(await ensureCli(env))) return;
          } catch {
            return;
          }
          if (disposed) return;
          // Off the Send path: a sign-in change drops every host this instance holds.
          const seen = readIdentity();
          remember(seen);
          if (seen !== identity) {
            identity = seen;
            pool.invalidate({ instanceId, incarnation }, "identity changed");
          }
          checked = Math.max(checked, round);
          const fresh = capture();
          // A shape captured for another sign-in, generation or incarnation is stale.
          if (shape && (shape.captured.generation !== fresh.generation || shape.captured.identity !== fresh.identity
            || shape.captured.incarnation !== fresh.incarnation)) return;
          await (shape && identity ? prepareSession(shape, fresh) : prepareHandshake());
        },
        cachedCapture: () =>
          input.enabled && !disposed && lastCapture && lastCapture.identity && lastCapture.generation === generationNow()
            ? { ...lastCapture }
            : null,
        dispose: async () => {
          disposed = true;
          lastCapture = null;
          text?.dispose();
          pool.invalidate({ instanceId, incarnation }, "dispose");
          for (const child of [...children]) {
            try {
              killCliTree(child);
            } catch {
              // already gone
            }
          }
          children.clear();
        },
      };
    },
  };
}
