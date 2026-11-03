import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { isInstanceId } from "./accounts.ts";
import { terminalPaneCountsGrant } from "./terminal-grant.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";
import type { createWorkerLaunch } from "./worker-launch.ts";

const inputSchema = z.object({
  botId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), label: z.string().max(40).optional(),
  command: z.string().max(64 * 1024), environment: z.record(z.string(), z.string()), mode: z.literal("send").optional(),
});
const countSchema = z.object({ count: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(), generations: z.record(z.string(), z.number().int().nonnegative()) });

export async function workerLaunchResponse(access: TerminalBridgeAccess | null, token: unknown, input: unknown, prepare: ReturnType<typeof createWorkerLaunch>) {
  if (typeof token !== "string" || !access) return { status: 401, body: { error: "Unauthorized worker launch" } };
  const received = Buffer.from(token);
  const expected = Buffer.from(access.token);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { status: 401, body: { error: "Unauthorized worker launch" } };
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
