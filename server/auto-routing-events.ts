import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { autoDecisionEventSchema, autoOutcomeEventSchema, classifyAutoTask, type AutoDecision, type AutoDecisionEvent, type AutoOutcomeEvent, type TaskData } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";

type Decision = Extract<AutoDecision, { kind: "selected" }>;
type EventRoute = { routeId: string; botId: string; at: number; paneId?: string };

export class AutoRoutingEvents {
  private readonly salt: string;
  private readonly file: string;
  private readonly append: typeof appendFileSync;
  coverageMissing = false;

  constructor(dataDir: string, append = appendFileSync) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, "auto-routing-event-key");
    this.salt = existsSync(file) ? readFileSync(file, "utf8").trim() : randomBytes(32).toString("hex");
    if (!/^[a-f0-9]{64}$/.test(this.salt)) throw new Error("Invalid Auto event key");
    if (!existsSync(file)) writeFileAtomic(file, `${this.salt}\n`, { mode: 0o600 });
    this.file = join(dataDir, "auto-routing-events.jsonl");
    this.append = append;
  }

  ref(value: string): string { return createHmac("sha256", this.salt).update(value).digest("hex").slice(0, 32); }

  decision(row: EventRoute, decision: Decision, task: TaskData, pinned: Array<"engine" | "model" | "effort" | "account">): boolean {
    const classified = classifyAutoTask(task);
    const { engine, model, effort, account, generation } = decision.route;
    return this.write(() => autoDecisionEventSchema.parse({
      v: 1, kind: "decision", routeId: row.routeId, at: row.at, target: "worker", botRef: this.ref(`bot:${row.botId}`),
      pane8: row.paneId ? this.ref(`pane:${row.paneId}`).slice(0, 8) : undefined,
      taskClass: decision.taskClass, risk: classified.taskClass === "protected" ? "protected" : task.risk ?? "unknown", classSource: classified.source,
      rulesVersion: decision.rulesVersion, pinned, habit: null, reasonCode: decision.reason, excluded: [],
      usageLeft: { session: null, weekly: null, ageSec: null },
      chosen: { engine, model, effort, acctRef: this.ref(`account:${account}:${generation}`) },
    }));
  }

  outcome(row: EventRoute, kind: AutoOutcomeEvent["kind"], status: AutoOutcomeEvent["status"], at: number): boolean {
    return this.write(() => autoOutcomeEventSchema.parse({
      routeId: row.routeId, at, target: "worker", kind, status, durationSec: Math.max(0, at - row.at) / 1000,
      botRef: this.ref(`bot:${row.botId}`), pane8: row.paneId ? this.ref(`pane:${row.paneId}`).slice(0, 8) : undefined,
    }));
  }

  private write(event: () => AutoDecisionEvent | AutoOutcomeEvent): boolean {
    try { this.append(this.file, `${JSON.stringify(event())}\n`, { mode: 0o600 }); return true; }
    catch { this.coverageMissing = true; return false; }
  }
}
