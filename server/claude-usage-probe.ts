import { createInterface } from "node:readline";
import { z } from "zod";

import type { AccountContext } from "./account-policy.ts";
import type { RateLimitWindow } from "./contracts.ts";
import { killCliTree, spawnCli } from "./procs.ts";

const window = z.object({
  utilization: z.number().finite().min(0).max(100),
  resets_at: z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable(),
});
const usage = z.object({
  rate_limits_available: z.literal(true),
  rate_limits: z.object({ five_hour: window.nullable(), seven_day: window.nullable() }),
});
const response = z.object({
  type: z.literal("control_response"),
  response: z.object({ subtype: z.literal("success"), request_id: z.string(), response: z.unknown() }),
});
type Report = { windows: RateLimitWindow[]; observedAt: string };

export function readClaudeUsage(cli: string, env: NodeJS.ProcessEnv, account: AccountContext): Promise<RateLimitWindow[]> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(cli, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"], {
      cwd: account.home, env, stdio: ["pipe", "pipe", "pipe"], account, accountDriver: "claudeAgent",
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let requestId = "initialize";
    const finish = (windows?: RateLimitWindow[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killCliTree(child);
      if (windows?.length) resolve(windows);
      else reject(new Error("Claude usage unavailable"));
    };
    const send = (request: object) => {
      try {
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`, (error) => { if (error) finish(); });
      } catch { finish(); }
    };
    const timer = setTimeout(() => finish(), 15_000);
    child.stderr.resume();
    child.once("error", () => finish());
    child.once("exit", () => finish());
    child.stdin.on("error", () => finish());
    child.stdout.on("error", () => finish());
    lines.on("error", () => finish());
    lines.on("line", (line) => {
      if (settled) return;
      try {
        const frame = z.object({ type: z.string() }).parse(JSON.parse(line));
        if (frame.type === "system") return;
        const message = response.parse(JSON.parse(line)).response;
        if (message.request_id !== requestId) throw new Error("Unexpected usage response");
        if (requestId === "initialize") {
          z.object({}).parse(message.response);
          requestId = "usage";
          send({ subtype: "get_usage", skip_behaviors: true });
        } else {
          const limits = usage.parse(message.response).rate_limits;
          finish(Object.entries(limits).flatMap(([id, value]) => value ? [{
            id, usedPercent: value.utilization, resetsAt: value.resets_at === null ? null : Date.parse(value.resets_at),
            windowMinutes: id === "five_hour" ? 300 : 10080,
          }] : []));
        }
      } catch { finish(); }
    });
    send({ subtype: "initialize", hooks: {} });
  });
}

export function createClaudeUsageProbe(deps: {
  read?: typeof readClaudeUsage; now?: () => number; random?: () => number;
} = {}) {
  const now = deps.now ?? Date.now;
  const reads = new Map<string, { generation: number; retryAt: number; pending: Promise<Report | undefined> }>();
  let queue: Promise<unknown> = Promise.resolve();
  const probe = (cli: string, env: NodeJS.ProcessEnv, account: AccountContext) => {
    const cached = reads.get(account.id);
    if (cached && now() < cached.retryAt) return cached.generation === account.generation ? cached.pending : Promise.resolve(undefined);
    const entry = { generation: account.generation, retryAt: Infinity, pending: Promise.resolve<Report | undefined>(undefined) };
    entry.pending = queue.then(async () => {
      entry.retryAt = now() + 300_000 + Math.floor((deps.random ?? Math.random)() * 30_000);
      try {
        const windows = await (deps.read ?? readClaudeUsage)(cli, env, account);
        return { windows, observedAt: new Date(now()).toISOString() };
      } catch { return undefined; }
    });
    reads.set(account.id, entry);
    queue = entry.pending;
    return entry.pending;
  };
  return Object.assign(probe, { invalidate: (id: string) => { reads.delete(id); } });
}
