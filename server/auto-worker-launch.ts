import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { parsePaneNote } from "../shared/pane-note.ts";
import { AUTO_ENGINES, autoEffortSchema, autoTaskSchema, type AutoEngine, type AutoRoute, type TaskData } from "../shared/auto-routing.ts";
import type { UsageEvidence } from "../shared/usage-windows.ts";
import { AutoRoutingEvents } from "./auto-routing-events.ts";
import { AutoRoutingRuntime, type AutoWorkerCandidate, type AutoWorkerRow, type AutoWorkerTurn } from "./auto-routing-runtime.ts";
import type { createAutoRoutingService } from "./auto-routing-service.ts";
import type { AccountContext } from "./account-policy.ts";
import type { InstanceConfigMap, ModelCatalog } from "./contracts.ts";
import { STATIC_GROK_MODELS } from "./drivers/acp/grok.ts";
import { STATIC_CLAUDE_MODELS } from "./drivers/claude.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";
import { MSP_MUSE_MODELS } from "./drivers/msp/muse.ts";
import { turnRegistry } from "./turn-registry.ts";
import type { createWorkerLaunch } from "./worker-launch.ts";
import type { WorkerTurnResolver } from "./worker-turn.ts";

const REFRESH_DEADLINE_MS = 3_000;
const STALE_MS = 5 * 60_000;
const EXECUTABLES = { claudeAgent: "claude", codex: "codex", grokAgent: "grok", museAgent: "muse", antigravityAgent: "agy" } satisfies Record<AutoEngine, string>;
const CATALOGS = { claudeAgent: STATIC_CLAUDE_MODELS, codex: STATIC_CODEX_MODELS, grokAgent: STATIC_GROK_MODELS, museAgent: MSP_MUSE_MODELS } satisfies Partial<Record<AutoEngine, ModelCatalog>>;
const ENGINE_IDS: ReadonlySet<string> = new Set(AUTO_ENGINES);
const autoEngine = (driver: string | undefined): driver is AutoEngine => driver !== undefined && ENGINE_IDS.has(driver);
const GEMINI_MODELS = ["low", "medium", "high"].map((effort) => `gemini-3.8-flash-${effort}`);
const WORKER_TOOLS = ["code", "shell", "web", "subagents", "workflow"];
const PANE_VARS = ["ORBIT_PANE", "ORBIT_BOT", "ORBIT_TEACHER", "ORBIT_URL", "ORBIT_MSG_AUTH"];

export const autoSpawnSchema = z.object({
  task: z.object({ prompt: z.string().min(1).max(32 * 1024), kind: autoTaskSchema, risk: z.enum(["low", "high", "protected", "unknown"]), scope: z.enum(["bounded", "mechanical", "multi-source", "large", "unknown"]),
    tools: z.array(z.string().max(64)).max(32).optional() }).strict(),
  pin: z.object({ model: z.string().max(128).optional(), effort: autoEffortSchema.optional(), userQuote: z.string().min(1).max(4096) }).strict().optional(),
}).strict();
type AutoSpawn = z.infer<typeof autoSpawnSchema>;
type LaunchInput = Parameters<ReturnType<typeof createWorkerLaunch>>[0] & { auto?: AutoSpawn; cwd?: string };
export type AutoSignal = { routeId: string; event: "accepted" | "rejected" | "uncertain" | "closed" | "limit" | "stalled" | "recovered"; paneId?: string; nativeId?: string };
type HostRuns = { known: true; runs: { routeId: string; nativeId: string; paneId: string }[] } | { known: false };
type ExternalRuns = { known: true; runs: { paneId: string; accountId: string; accountGeneration: number }[] } | { known: false };

export function autoCandidates(deps: {
  bases(): InstanceConfigMap; accounts(): readonly AccountContext[];
  currentGeneration(id: string): number | undefined; signedIn(id: string, generation: number): boolean; draining(id: string): boolean;
  efforts(id: string): readonly AutoRoute["effort"][];
  main(of: string): AccountContext | undefined | null;
  usage(id: string): UsageEvidence | undefined;
}): AutoWorkerCandidate[] {
  const bases = deps.bases();
  const rows = [...Object.entries(bases).map(([id, base]) => ({ id, generation: 0, of: id, base })),
    ...deps.accounts().map((account) => ({ id: account.id, generation: account.generation, of: account.of, base: bases[account.of] }))];
  return rows.flatMap(({ base, ...account }) => {
    const engine = base?.driver;
    if (!autoEngine(engine) || base.enabled === false) return [];
    const row = { ...account, engine };
    const current = deps.currentGeneration(row.id);
    if (current === undefined) return [];
    const main = deps.main(row.of);
    return [{ engine: row.engine, account: row.id, generation: row.generation, currentGeneration: current, authorized: true, signedIn: deps.signedIn(row.id, row.generation),
      lifecycle: deps.draining(row.id) ? "draining" as const : "ready" as const, subscription: true,
      models: row.engine === "antigravityAgent" ? GEMINI_MODELS : CATALOGS[row.engine].options.map((option) => option.id),
      effortLevels: deps.efforts(row.id), tools: WORKER_TOOLS, contextTokens: 200_000, usage: deps.usage(row.id), loadKnown: true,
      main: main ? main.id === row.id : row.generation === 0, externalActive: 0 }];
  });
}

function autoArgv(route: AutoRoute, row: AutoWorkerRow, prompt: string, cwd: string) {
  const win32 = process.platform === "win32";
  const bin = join(homedir(), ".orbit", "bin");
  const settings = join(bin, "claude-worker.json").replace(/\\/g, "/");
  const notify = `notify=["powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-File","${join(bin, "orbit-msg.ps1").replace(/\\/g, "/")}","--notify","last-assistant-message"]`;
  if (route.engine === "claudeAgent") return ["--model", route.model, "--effort", route.effort, "--dangerously-skip-permissions", ...(win32 && existsSync(settings) ? ["--settings", settings] : []), "--session-id", row.nativeId, prompt];
  if (route.engine === "codex") return ["--model", route.model, "-c", `model_reasoning_effort=${route.effort}`, "-c", `projects={${JSON.stringify(cwd)}={trust_level='trusted'}}`, "--dangerously-bypass-approvals-and-sandbox",
    ...(win32 ? [...PANE_VARS.flatMap((name) => ["-c", `shell_environment_policy.set.${name}='\u0000${name}\u0000'`]), "-c", notify] : []), prompt];
  if (route.engine === "museAgent") return ["--model", route.model, "--reasoning-effort", route.effort, "--yolo", prompt];
  if (route.engine === "grokAgent") return ["-m", route.model, "--effort", route.effort, "--always-approve", "--trust", prompt];
  return ["--model", route.model, "--dangerously-skip-permissions", "-i", prompt];
}

const paneLabel = (label: string | undefined, route: AutoRoute) => {
  const rest = ` | ${route.model} | ${route.effort}`;
  return `${(label ?? "").split("|")[0].trim().slice(0, 40 - rest.length)}${rest}`;
};
const held = (reason: string) => ({ kind: "hold" as const, hold: `Auto held this worker (${reason}). Nothing launched, and repeating the spawn will not override it. Tell the user; they can name a model or wait for usage to reset.` });

export function createAutoWorkers(deps: {
  dataDir: string; service: ReturnType<typeof createAutoRoutingService>; workerLaunch: ReturnType<typeof createWorkerLaunch>;
  resolveWorkerTurn: WorkerTurnResolver; candidates(): AutoWorkerCandidate[]; available(id: string, generation: number): boolean;
  refresh(id: string): Promise<void>; hostRuns(): Promise<HostRuns>; liveRuns?(): Promise<ExternalRuns>;
}) {
  const turns = new Map<string, AutoWorkerTurn>();
  let hostKnown = true;
  let built: AutoRoutingRuntime | undefined;
  const stateFile = join(deps.dataDir, "auto-routing-workers.json");
  let external: Extract<ExternalRuns, { known: true }>["runs"] = [];
  const turn = (botId: string) => {
    const worker = deps.resolveWorkerTurn(botId);
    const live = worker?.threadId ? turnRegistry.current(worker.threadId) : undefined;
    if (!worker || !live) { turns.delete(botId); return undefined; }
    const prior = turns.get(botId);
    if (prior?.id === live.turnId) return prior;
    const next = { id: live.turnId, threadId: worker.threadId };
    turns.set(botId, next);
    return next;
  };
  const taskOf = (botId: string, active: AutoWorkerTurn) => active.threadId ? deps.service.taskId(botId, active.threadId) : undefined;
  // Built on first use so bad Auto state can never stop the server for anyone with Auto off.
  const runtime = (): AutoRoutingRuntime => {
    if (built) return built;
    built = new AutoRoutingRuntime(deps.dataDir, {
      enabled: (botId) => deps.service.state.get(botId)?.enabled === true,
      turn,
      source: (botId, active) => deps.service.source(botId, active.threadId!),
      kept: (botId, active) => { const taskId = taskOf(botId, active); return taskId ? deps.service.state.pick(botId, active.threadId!, taskId) : undefined; },
      habit: (taskClass, now) => deps.service.habit(taskClass, now),
      observe: (botId, active, route, choice, context) => deps.service.spawnPin(botId, active.threadId!, route, choice, context),
      bind: (botId, active, route, taskClass) => deps.service.bindPick(botId, active.threadId!, route, taskClass),
      transaction: deps.service.transaction,
      rules: () => deps.service.rules.current(),
      candidates: () => deps.candidates().map((candidate) => ({ ...candidate, loadKnown: candidate.loadKnown && hostKnown,
        externalActive: external.filter((run) => run.accountId === candidate.account && run.accountGeneration === candidate.generation && !runtime().rows().some((row) => row.paneId === run.paneId)).length })),
      valid: (route) => deps.available(route.account, route.generation),
      refresh: async (route) => { await deps.refresh(route.account); },
      events: new AutoRoutingEvents(deps.dataDir),
    }, deps.service.write);
    deps.service.register(built);
    return built;
  };
  const whenStarted = (run: (active: AutoRoutingRuntime) => void) => {
    try { if (built || existsSync(stateFile)) run(runtime()); }
    catch { console.error("Auto worker state is unavailable"); }
  };
  const freshen = async (route: AutoRoute, deadline: number): Promise<void> => {
    const observed = Date.parse(deps.candidates().find((row) => row.account === route.account)?.usage?.observedAt ?? "");
    const left = deadline - Date.now();
    if (Date.now() - observed <= STALE_MS || left <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([deps.refresh(route.account).catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, left); })]);
    clearTimeout(timer);
  };
  return {
    get runtime() { return runtime(); },
    invalidate: (account: string) => whenStarted((active) => active.invalidate(account)),
    async launch(input: LaunchInput) {
      if (!input.auto) return deps.workerLaunch(input);
      const { task, pin } = input.auto;
      if (/[\x00-\x1f\x7f]/.test(task.prompt) || task.prompt.startsWith("-")) throw new Error("Auto task prompt must be one line and must not start with a dash");
      if (!input.cwd) throw new Error("Terminal folder is unavailable");
      const active = turn(input.botId);
      if (!active) return held("no live turn");
      if (deps.liveRuns) {
        const runs = await deps.liveRuns();
        hostKnown = runs.known;
        external = runs.known ? runs.runs : [];
      }
      const requestId = createHash("sha256").update(JSON.stringify([active.id, input.label, input.cwd, task, pin ?? null])).digest("hex");
      const taskData: TaskData = { text: task.prompt, kind: task.kind, risk: task.risk, scope: task.scope, source: "declared", tools: task.tools };
      const deadline = Date.now() + REFRESH_DEADLINE_MS;
      const result = await runtime().prepare({ requestId: `${requestId.slice(0, 8)}-${requestId.slice(8, 12)}-4${requestId.slice(13, 16)}-a${requestId.slice(17, 20)}-${requestId.slice(20, 32)}`, botId: input.botId, task: taskData, pin }, async (row) => {
        await freshen(row.route, deadline);
        if (!deps.available(row.route.account, row.route.generation)) return null;
        return deps.workerLaunch({ botId: input.botId, label: input.label, command: "", environment: input.environment, autoLaunch: {
          executable: EXECUTABLES[row.route.engine], args: autoArgv(row.route, row, task.prompt, input.cwd!), account: row.route.account, generation: row.route.generation,
          environment: row.route.engine === "antigravityAgent" ? { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } : {} } });
      });
      if (result.kind === "hold") return held(result.reason);
      if (result.kind === "existing") return result.row.stage === "running" && result.row.paneId ? { kind: "existing" as const, sessionId: result.row.paneId } : held(`this request already ran in this turn, stage ${result.row.stage}`);
      if (result.prepared?.kind !== "managed") { runtime().failed(result.row.routeId); return held("launch refused"); }
      const claimed = runtime().claim(result.row.routeId);
      return { ...result.prepared, label: paneLabel(input.label, claimed.route), auto: { routeId: claimed.routeId, nativeId: claimed.nativeId }, line: `Auto picked ${claimed.route.model} ${claimed.route.effort}.` };
    },
    async signal(input: AutoSignal) {
      if (input.event === "accepted") runtime().accepted(input.routeId, input.paneId ?? "");
      else if (input.event === "rejected") runtime().rejected(input.routeId);
      else if (input.event === "uncertain") runtime().uncertain(input.routeId);
      else if (input.event === "recovered") runtime().recovered(input.routeId, input.nativeId ?? "", input.paneId ?? "");
      else runtime().outcome(input.routeId, input.event);
    },
    paneReport(paneId: string, text: string) {
      const status = parsePaneNote(text).status;
      if (status) whenStarted((active) => {
        const row = active.rows().find((entry) => entry.paneId === paneId && ["running", "unknown"].includes(entry.stage));
        if (row) active.outcome(row.routeId, "report", status);
      });
    },
    async reconcile() {
      if (!built && !existsSync(stateFile)) return;
      const host = await deps.hostRuns();
      hostKnown = host.known;
      if (!host.known) return;
      for (const row of runtime().rows()) {
        const run = host.runs.find((entry) => entry.routeId === row.routeId);
        if (row.stage === "unknown" && run) { runtime().recovered(row.routeId, run.nativeId, run.paneId); continue; }
        if (!run && (row.stage === "running" || row.stage === "unknown")) runtime().outcome(row.routeId, "closed");
      }
    },
  };
}
