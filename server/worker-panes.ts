import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { isInstanceId } from "./accounts.ts";
import { terminalPaneCountsGrant } from "./terminal-grant.ts";
import { autoSpawnSchema, type AutoSignal } from "./auto-worker-launch.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

const inputSchema = z.object({
  botId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), label: z.string().max(40).optional(),
  command: z.string().max(64 * 1024), environment: z.record(z.string(), z.string()), mode: z.literal("send").optional(), unrouted: z.literal(true).optional(), auto: autoSpawnSchema.optional(), cwd: z.string().max(4096).optional(),
  resume: z.object({ engine: z.enum(["claude", "codex"]), nativeId: z.string().uuid(), accountId: z.string().refine(isInstanceId),
    accountGeneration: z.number().int().nonnegative(), template: z.object({ executable: z.string().max(32), args: z.array(z.string().max(64 * 1024)).max(1024) }),
    unrouted: z.literal(true).optional() }).optional(),
});
const countSchema = z.object({ count: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(), generations: z.record(z.string(), z.number().int().nonnegative()) });
const runsSchema = z.object({ runs: z.array(z.object({
  botId: z.string().regex(/^[\w-]{1,128}$/), paneId: z.string().min(1).max(128), label: z.string().max(40).nullable(),
  engine: z.enum(["claude", "codex"]), accountId: z.string().refine(isInstanceId),
  accountGeneration: z.number().int().nonnegative(), state: z.enum(["busy", "idle", "limit", "starting"]),
})) });

export type WorkerRun = z.infer<typeof runsSchema>["runs"][number];
export type WorkerRuns = { known: true; runs: WorkerRun[] } | { known: false; reason: "no-host" | "old-host" | "error" | "timeout" };

export async function liveWorkerRuns(access: TerminalBridgeAccess | null, filter: { botId?: string; engine?: "claude" | "codex" } = {}, timeoutMs = 5_000, fetchImpl: typeof fetch = fetch): Promise<WorkerRuns> {
  if (!access) return { known: false, reason: "no-host" };
  const query = new URLSearchParams();
  if (filter.botId !== undefined) query.set("botId", filter.botId);
  if (filter.engine !== undefined) query.set("engine", filter.engine);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(`${access.url}/v1/terminal/account-runs${query.size ? `?${query}` : ""}`, {
      headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` }, redirect: "error", signal,
    });
    if (response.status === 404) return { known: false, reason: "old-host" };
    if (!response.ok) return { known: false, reason: "error" };
    const parsed = runsSchema.safeParse(await response.json());
    if (parsed.success) return { known: true, runs: parsed.data.runs };
  } catch {
    if (signal.aborted) return { known: false, reason: "timeout" };
  }
  return { known: false, reason: "error" };
}

const autoRunsSchema = z.object({ runs: z.array(z.object({ routeId: z.string().min(1), nativeId: z.string().min(1), paneId: z.string().min(1) })) });
const autoSignalSchema = z.object({ routeId: z.string().regex(/^[a-f0-9]{32}$/), event: z.enum(["accepted", "rejected", "uncertain", "closed", "limit", "stalled", "recovered"]),
  paneId: z.string().min(1).max(128).optional(), nativeId: z.string().uuid().optional() }).strict();

function hostTokenMatches(access: TerminalBridgeAccess | null, token: unknown): access is TerminalBridgeAccess {
  if (typeof token !== "string" || !access) return false;
  const received = Buffer.from(token);
  const expected = Buffer.from(access.token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function liveAutoRuns(access: TerminalBridgeAccess | null, fetchImpl: typeof fetch = fetch) {
  if (!access) return { known: false as const };
  try {
    const response = await fetchImpl(`${access.url}/v1/terminal/auto-runs`, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const parsed = autoRunsSchema.safeParse(await response.json());
    if (response.ok && parsed.success) return { known: true as const, runs: parsed.data.runs };
  } catch {}
  return { known: false as const };
}

export async function workerAutoResponse(access: TerminalBridgeAccess | null, token: unknown, input: unknown, signal: (input: AutoSignal) => Promise<void>) {
  if (!hostTokenMatches(access, token)) return { status: 401, body: { error: "Unauthorized worker launch" } };
  const parsed = autoSignalSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "Invalid worker signal" } };
  try {
    await signal(parsed.data);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return { status: 409, body: { error: error instanceof Error ? error.message : "Worker signal was refused" } };
  }
}

export async function workerLaunchResponse<T>(access: TerminalBridgeAccess | null, token: unknown, input: unknown, prepare: (input: z.infer<typeof inputSchema>) => Promise<T>) {
  if (!hostTokenMatches(access, token)) return { status: 401, body: { error: "Unauthorized worker launch" } };
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "Invalid worker launch" } };
  try {
    return { status: 200, body: { launch: await prepare(parsed.data) } };
  } catch (error) {
    return { status: 409, body: { error: error instanceof Error ? error.message : "Worker launch was refused" } };
  }
}

export async function livePanesForAccount(access: TerminalBridgeAccess | null, accountId: string, fetchImpl: typeof fetch = fetch) {
  if (!access || !isInstanceId(accountId)) return { count: 0, unknown: 1, generations: {} };
  try {
    const response = await fetchImpl(`${access.url}/v1/terminal/account-panes?accountId=${encodeURIComponent(accountId)}`, {
      headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` }, redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    const parsed = countSchema.safeParse(await response.json());
    if (response.ok && parsed.success) return parsed.data;
  } catch {}
  return { count: 0, unknown: 1, generations: {} };
}

export async function enableWorkerAccounts(access: TerminalBridgeAccess | null, fetchImpl: typeof fetch = fetch) {
  if (!access) return;
  const response = await fetchImpl(`${access.url}/v1/terminal/worker-accounts`, {
    method: "POST", headers: { authorization: `Bearer ${access.token}` }, redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || !z.object({ enabled: z.literal(true) }).safeParse(await response.json()).success) throw new Error("Worker account routing is unavailable");
}
