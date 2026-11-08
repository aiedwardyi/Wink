import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { autoEffortSchema, autoEngineSchema, classifyAutoTask, selectAutoRoute, validAutoArm, type AutoCandidate, type AutoDimensions, type AutoPreference, type AutoRoute, type AutoRules, type AutoTask, type ChoiceContext, type ChoiceProvenance, type TaskData } from "../shared/auto-routing.ts";
import { applicableWindows, assessUsage } from "../shared/usage-windows.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { AutoRoutingEvents } from "./auto-routing-events.ts";
import { names, userChoice, type AttributionSource } from "./auto-routing-attrib.ts";

const routeSchema = z.object({ engine: autoEngineSchema, model: z.string(), effort: autoEffortSchema,
    account: z.string().min(1), generation: z.number().int().nonnegative(), tier: z.enum(["cheap", "mid", "strong"]),
    reviewLabel: z.enum(["second family", "same family", "same model, fresh look"]).optional(), freshReview: z.boolean().optional(), independentCheck: z.boolean().optional() }).strict().refine(validAutoArm);
const rowSchema = z.object({
  requestId: z.string().uuid(), routeId: z.string().regex(/^[a-f0-9]{32}$/), botId: z.string().min(1), turnId: z.string().min(1),
  nativeId: z.string().uuid(), at: z.number().int().nonnegative(),
  rulesVersion: z.number().int().nonnegative(), route: routeSchema,
  stage: z.enum(["preparing", "ready", "accepting", "running", "unknown", "ended", "failed"]),
  attempts: z.number().int().min(1).max(2), paneId: z.string().min(1).optional(), coverageMissing: z.boolean(),
}).strict();
const usageSchema = z.object({ observedAt: z.string(), windows: z.array(z.object({
  id: z.string(), usedPercent: z.number().finite(), resetsAt: z.number().nullable(), windowMinutes: z.number().optional(),
}).strict()) }).strict();
const stateSchema = z.object({ v: z.literal(1), rows: z.array(rowSchema), limits: z.record(z.string(), usageSchema) }).strict().refine((state) =>
  new Set(state.rows.map((row) => row.requestId)).size === state.rows.length
  && new Set(state.rows.map((row) => row.routeId)).size === state.rows.length);
export type AutoWorkerRow = z.infer<typeof rowSchema>;
export type AutoWorkerCandidate = Omit<AutoCandidate, "pending" | "active"> & { externalActive: number };
export type AutoWorkerTurn = { id: string; threadId?: string };
type Request = { requestId: string; botId: string; task: TaskData; pin?: { model?: string; effort?: AutoDimensions["effort"]; userQuote: string } };
type Preparation<T> = { kind: "ready"; row: AutoWorkerRow; prepared: T } | { kind: "hold"; reason: string } | { kind: "existing"; row: AutoWorkerRow };
type Deps = {
  enabled(botId: string): boolean;
  turn(botId: string): AutoWorkerTurn | undefined;
  source?(botId: string, turn: AutoWorkerTurn): AttributionSource;
  kept?(botId: string, turn: AutoWorkerTurn): AutoDimensions | undefined;
  keep?(botId: string, turn: AutoWorkerTurn, choice: ChoiceProvenance, context: ChoiceContext): void;
  observe?(botId: string, turn: AutoWorkerTurn, route: AutoRoute, choice: ChoiceProvenance, context: ChoiceContext): void;
  bind?(botId: string, turn: AutoWorkerTurn, route: AutoRoute, taskClass: AutoTask): void;
  habit?(taskClass: AutoTask, now: number): AutoPreference | undefined;
  transaction?<T>(run: () => T): T;
  rules(): { id: number; content: AutoRules };
  candidates(): readonly AutoWorkerCandidate[];
  valid(route: AutoRoute, turn: AutoWorkerTurn): boolean;
  refresh(route: AutoRoute): Promise<void>;
  events: Pick<AutoRoutingEvents, "decision" | "outcome">;
  now?: () => number;
};

const pending = (row: AutoWorkerRow) => row.stage === "preparing" || row.stage === "ready";
const active = (row: AutoWorkerRow) => ["accepting", "running", "unknown"].includes(row.stage);
const sameAccount = (route: AutoRoute, candidate: Pick<AutoCandidate, "engine" | "account" | "generation">) =>
  route.engine === candidate.engine && route.account === candidate.account && route.generation === candidate.generation;
const accountKey = (route: Pick<AutoRoute, "engine" | "account" | "generation">) => JSON.stringify([route.engine, route.account, route.generation]);
const direct = <T>(run: () => T) => run();

export class AutoRoutingRuntime {
  private state: z.infer<typeof stateSchema> = { v: 1, rows: [], limits: {} };
  private readonly file: string;
  private readonly deps: Deps;
  private readonly write: typeof writeFileAtomic;
  private readonly now: () => number;
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly preparations = new Map<string, { turn: AutoWorkerTurn; task: TaskData }>();

  constructor(dataDir: string, deps: Deps, write = writeFileAtomic) {
    this.file = join(dataDir, "auto-routing-workers.json");
    this.deps = deps;
    this.write = write;
    this.now = deps.now ?? Date.now;
    const marker = join(dataDir, "auto-routing-workers.created");
    if (existsSync(this.file) !== existsSync(marker)) throw new Error("Auto worker state is missing");
    if (existsSync(this.file)) {
      this.reload();
      const rows = this.state.rows.map((row) => ({ ...row, stage: pending(row) ? "failed" as const : row.stage === "accepting" ? "unknown" as const : row.stage }));
      this.save(rows);
    } else {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      this.write(marker, "1\n", { mode: 0o600 });
      this.save([]);
    }
  }

  reload(): void { this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))); }

  rows(): AutoWorkerRow[] { return structuredClone(this.state.rows); }

  candidates(): AutoCandidate[] {
    return this.deps.candidates().map(({ externalActive, ...candidate }) => {
      const own = this.state.rows.filter((row) => sameAccount(row.route, candidate));
      const priorUsage = this.state.limits[accountKey(candidate)];
      return { ...candidate, pending: own.filter(pending).length, active: externalActive + own.filter(active).length,
        loadKnown: candidate.loadKnown && !own.some((row) => row.stage === "unknown"), priorUsage: priorUsage ?? candidate.priorUsage };
    });
  }

  async prepare<T>(request: Request, prepare: (row: AutoWorkerRow) => Promise<T>): Promise<Preparation<T>> {
    z.string().uuid().parse(request.requestId);
    const prior = this.state.rows.find((row) => row.requestId === request.requestId);
    if (prior) {
      if (prior.botId !== request.botId) return { kind: "hold", reason: "request-owner-mismatch" };
      return { kind: "existing", row: structuredClone(prior) };
    }
    const turn = this.deps.turn(request.botId);
    if (!turn || !this.deps.enabled(request.botId)) return { kind: "hold", reason: "auto-unavailable" };
    const source = this.deps.source?.(request.botId, turn);
    const dimensions: AutoDimensions = {};
    if (request.pin?.model) { dimensions.model = request.pin.model; dimensions.engine = names(request.pin.userQuote).engine; }
    if (request.pin?.effort) dimensions.effort = request.pin.effort;
    const taskClass = classifyAutoTask(request.task).taskClass;
    const attributed = request.pin && source && source.turn?.turnId === turn.id
      ? userChoice(source, "worker", taskClass, request.pin.userQuote, dimensions) : undefined;
    if (request.pin && !attributed) return { kind: "hold", reason: "unverified-pin" };
    const pin = attributed?.choice.dimensions ?? this.deps.kept?.(request.botId, turn);
    const select = () => {
      const rules = this.deps.rules();
      return selectAutoRoute({ target: "worker", task: request.task, now: this.now(),
        candidates: this.candidates(), rules: rules.content, rulesVersion: rules.id,
        habit: this.deps.habit?.(taskClass, this.now()), pin, pinVerified: Boolean(pin) });
    };
    let decision = select();
    if (decision.kind !== "selected") return { kind: "hold", reason: decision.reason };
    let row: AutoWorkerRow = { requestId: request.requestId, routeId: randomBytes(16).toString("hex"), botId: request.botId,
      turnId: turn.id, nativeId: randomUUID(), at: this.now(), rulesVersion: decision.rulesVersion,
      route: routeSchema.parse(decision.route), stage: "preparing", attempts: 1, coverageMissing: false };
    (this.deps.transaction ?? direct)(() => {
      if (attributed) {
        this.deps.keep?.(request.botId, turn, attributed.choice, attributed.context);
        this.deps.observe?.(request.botId, turn, row.route, attributed.choice, attributed.context);
      } else if (pin) this.deps.bind?.(request.botId, turn, row.route, taskClass);
      this.put(row);
    });
    this.preparations.set(row.routeId, { turn, task: structuredClone(request.task) });
    try {
      for (;;) {
        const prepared = await prepare(structuredClone(row));
        if (this.current(row, turn)) {
          const pinned = (["engine", "model", "effort", "account"] as const).filter((key) => pin?.[key] !== undefined);
          row = { ...row, stage: "ready", coverageMissing: !this.deps.events.decision(row, decision, request.task, pinned) };
          this.put(row);
          return { kind: "ready", row: structuredClone(row), prepared };
        }
        if (this.deps.turn(row.botId) !== turn || !this.deps.enabled(row.botId) || !pending(this.get(row.routeId)) || row.attempts === 2) break;
        const next = select();
        if (next.kind !== "selected") break;
        decision = next;
        row = { ...row, route: routeSchema.parse(next.route), rulesVersion: next.rulesVersion, attempts: 2 };
        this.put(row);
      }
      this.put({ ...this.get(row.routeId), stage: "failed" });
      return { kind: "hold", reason: "route-invalidated" };
    } catch (error) {
      this.put({ ...this.get(row.routeId), stage: "failed" });
      throw error;
    }
  }

  claim(routeId: string): AutoWorkerRow {
    const row = this.get(routeId);
    const turn = this.deps.turn(row.botId);
    if (row.stage !== "ready" || !turn || !this.current(row, turn)) {
      if (pending(row)) this.put({ ...row, stage: "failed" });
      throw new Error("Auto launch claim is unavailable");
    }
    const next = { ...row, stage: "accepting" as const };
    this.put(next);
    return structuredClone(next);
  }

  accepted(routeId: string, paneId: string): void {
    const row = this.get(routeId);
    if (row.stage === "running" && row.paneId === paneId) return;
    if (row.stage !== "accepting" || !paneId) throw new Error("Auto launch acceptance is unavailable");
    this.put({ ...row, stage: "running", paneId });
  }

  uncertain(routeId: string): void {
    const row = this.get(routeId);
    if (row.stage === "accepting") this.put({ ...row, stage: "unknown" });
  }

  rejected(routeId: string): void {
    const row = this.get(routeId);
    if (row.stage === "accepting") this.put({ ...row, stage: "failed" });
  }

  recovered(routeId: string, nativeId: string, paneId: string): void {
    const row = this.get(routeId);
    if ((row.stage !== "unknown" && row.stage !== "running") || row.nativeId !== nativeId || !paneId) throw new Error("Auto recovery identity is unavailable");
    this.put({ ...row, stage: "running", paneId });
  }

  failed(routeId: string): void {
    const row = this.get(routeId);
    if (pending(row)) this.put({ ...row, stage: "failed" });
  }

  invalidate(account: string): void {
    const rows = this.state.rows.map((row) => row.route.account === account && pending(row) ? { ...row, stage: "failed" as const } : row);
    if (rows.some((row, index) => row !== this.state.rows[index])) this.save(rows);
  }

  outcome(routeId: string, kind: "report" | "closed" | "limit" | "stalled", status: "done" | "failed" | "blocked" | null = null): void {
    const row = this.get(routeId);
    if (!active(row)) return;
    const written = this.deps.events.outcome(row, kind, status, this.now());
    const coverageMissing = row.coverageMissing || !written;
    let limits = this.state.limits;
    if (kind === "limit") {
      const candidate = this.deps.candidates().find((candidate) => sameAccount(row.route, candidate));
      const windows = applicableWindows(row.route.engine, row.route.model, candidate?.usage?.windows ?? []);
      limits = { ...limits, [accountKey(row.route)]: { observedAt: new Date(this.now()).toISOString(),
        windows: windows.length ? windows.map((window) => ({ id: window.id, resetsAt: window.resetsAt, windowMinutes: window.windowMinutes, usedPercent: 100 }))
          : [{ id: "unknown", usedPercent: 100, resetsAt: null }] } };
    }
    if (kind !== "stalled" || coverageMissing !== row.coverageMissing) this.save(this.state.rows.map((entry) => entry.routeId === routeId
      ? { ...row, stage: kind === "stalled" ? row.stage : "ended", coverageMissing } : entry), limits);
    if (kind === "limit") this.refresh(row.route);
  }

  private refresh(route: AutoRoute): void {
    const key = accountKey(route);
    if (this.refreshing.has(key)) return;
    const refresh = Promise.resolve().then(() => this.deps.refresh(route)).catch(() => {}).finally(() => { this.refreshing.delete(key); });
    this.refreshing.set(key, refresh);
  }

  private current(row: AutoWorkerRow, turn: AutoWorkerTurn): boolean {
    const preparation = this.preparations.get(row.routeId);
    if (!preparation || preparation.turn !== turn || !pending(this.get(row.routeId)) || this.deps.turn(row.botId) !== turn
      || row.rulesVersion !== this.deps.rules().id || !this.deps.enabled(row.botId) || !this.deps.valid(row.route, turn)) return false;
    const candidate = this.candidates().find((candidate) => sameAccount(row.route, candidate));
    if (!candidate) return false;
    const selected = selectAutoRoute({ target: "worker", task: preparation.task, now: this.now(),
      candidates: [candidate], rules: this.deps.rules().content, rulesVersion: this.deps.rules().id, pin: row.route, pinVerified: true });
    return selected.kind === "selected" && assessUsage(row.route.engine, row.route.model, candidate.usage, this.now(), candidate.priorUsage) !== "low";
  }

  private get(routeId: string): AutoWorkerRow {
    const row = this.state.rows.find((row) => row.routeId === routeId);
    if (!row) throw new Error("Unknown Auto route");
    return row;
  }

  private put(row: AutoWorkerRow): void { this.save([...this.state.rows.filter((entry) => entry.routeId !== row.routeId), row]); }

  private save(rows: AutoWorkerRow[], limits = this.state.limits): void {
    const state = stateSchema.parse({ v: 1, rows, limits });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    this.state = state;
    for (const row of rows) if (!pending(row)) this.preparations.delete(row.routeId);
  }
}
