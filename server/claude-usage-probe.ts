import type { SpawnOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

import { canonicalAccountHome, type AccountContext } from "./account-policy.ts";
import { DATA_DIR, scrubbedEnv } from "./config.ts";
import type { RateLimitWindow } from "./contracts.ts";
import { spawnCli } from "./procs.ts";
import { baseAccount } from "./worker-resume.ts";

const window = z.object({
  utilization: z.number().finite().min(0).max(100),
  resets_at: z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable(),
});
const usage = z.object({
  rate_limits_available: z.literal(true),
  rate_limits: z.looseObject({ five_hour: window.nullable(), seven_day: window.nullable() }),
});
const response = z.object({
  type: z.literal("control_response"),
  response: z.object({ subtype: z.literal("success"), request_id: z.string(), response: z.unknown() }),
});
type Report = { windows: RateLimitWindow[]; observedAt: string };
// Stays empty, as for the driver's lean helpers: the CLI lists its start folder.
const LEAN_DIR = join(DATA_DIR, "helper");
// One per config dir and never killed, as claude.ts's auth check: the CLI can be renewing the OAuth token, and a renewal cut short signs the account out.
const running = new Map<string, ReturnType<typeof spawnCli>>();

export function readClaudeUsage(cli: string, env: NodeJS.ProcessEnv, account?: AccountContext): Promise<RateLimitWindow[]> {
  const folder = canonicalAccountHome((account ?? baseAccount("claude", "claudeAgent", env)).home);
  if (running.has(folder)) return Promise.reject(new Error("Claude usage unavailable"));
  return new Promise((resolve, reject) => {
    if (!account) mkdirSync(LEAN_DIR, { recursive: true });
    const childEnv = scrubbedEnv(env);
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;
    const options: SpawnOptions = { cwd: account?.home ?? LEAN_DIR, env: childEnv, stdio: ["pipe", "pipe", "pipe"] };
    const child = spawnCli(cli, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
      account ? { ...options, account, accountDriver: "claudeAgent" } : options);
    running.set(folder, child);
    const lines = createInterface({ input: child.stdout });
    let windows: RateLimitWindow[] | undefined;
    let ended = false;
    let settled = false;
    let requestId = "initialize";
    // Closing stdin lets the CLI save whatever it started, such as a renewed token, and exit on its own.
    const finish = (found?: RateLimitWindow[]) => {
      if (ended) return;
      ended = true;
      windows = found;
      lines.close();
      child.stdout.resume();
      child.stdin.end();
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (windows?.length) resolve(windows);
      else reject(new Error("Claude usage unavailable"));
    };
    const exited = () => {
      if (running.get(folder) === child) running.delete(folder);
      finish();
      settle();
    };
    const send = (request: object) => {
      try {
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`, (error) => { if (error) finish(); });
      } catch { finish(); }
    };
    // A CLI still running at the deadline is abandoned, not killed, and keeps its folder until it exits.
    const timer = setTimeout(() => { finish(); settle(); }, 15_000);
    child.stderr.resume();
    child.once("error", () => { if (child.pid === undefined) exited(); else finish(); });
    child.once("exit", exited);
    child.stdin.on("error", () => finish());
    child.stdout.on("error", () => finish());
    lines.on("error", () => finish());
    lines.on("line", (line) => {
      if (ended) return;
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
          // Model weeks (seven_day_opus) gate limit waits on that model; a malformed one is skipped, not fatal.
          finish(Object.entries(limits).flatMap(([id, value]) => {
            const parsed = id === "five_hour" || id.startsWith("seven_day") ? window.safeParse(value) : undefined;
            return parsed?.success ? [{
              id, usedPercent: parsed.data.utilization, resetsAt: parsed.data.resets_at === null ? null : Date.parse(parsed.data.resets_at),
              windowMinutes: id === "five_hour" ? 300 : 10080,
            }] : [];
          }));
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
  const probe = (cli: string, env: NodeJS.ProcessEnv, account: AccountContext | undefined, id = account?.id ?? "") => {
    const generation = account?.generation ?? 0;
    const cached = reads.get(id);
    if (cached && now() < cached.retryAt) return cached.generation === generation ? cached.pending : Promise.resolve(undefined);
    const entry = { generation, retryAt: Infinity, pending: Promise.resolve<Report | undefined>(undefined) };
    entry.pending = queue.then(async () => {
      entry.retryAt = now() + 300_000 + Math.floor((deps.random ?? Math.random)() * 30_000);
      try {
        const windows = await (deps.read ?? readClaudeUsage)(cli, env, account);
        return { windows, observedAt: new Date(now()).toISOString() };
      } catch { return undefined; }
    });
    reads.set(id, entry);
    queue = entry.pending;
    return entry.pending;
  };
  return Object.assign(probe, { invalidate: (id: string) => { reads.delete(id); } });
}
