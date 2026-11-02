import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { DelegationReceipt } from "./delegations.ts";
import { terminalMailState } from "./mail-types.ts";
import { redactSecretsInText } from "./redact.ts";

const FILE = join(DATA_DIR, "delegation-receipts.json");
const MAX_AGE = 48 * 60 * 60 * 1000;
let receipts: DelegationReceipt[] = [];

export function recordDelegationReceipt(receipt: Omit<DelegationReceipt, "finishedAt"> & { finishedAt?: number }): void {
  const now = Date.now();
  const existing = findDelegationReceipt(receipt.id);
  const next: DelegationReceipt = { ...existing, ...receipt, finishedAt: receipt.finishedAt ?? now };
  if (!receipt.state) next.state = receipt.status === "denied" ? "refused" : receipt.status === "error" || receipt.status === "busy_gave_up" ? "failed" : receipt.status === "queued" ? "ready" : receipt.status;
  if (receipt.result !== undefined) {
    const result = redactSecretsInText(receipt.result);
    next.result = result.length > 16_000 ? `${result.slice(0, 16_000)}\n\n[reply cut: first 16000 of ${result.length} chars]` : result;
  }
  const all = [next, ...receipts.filter((row) => row.id !== receipt.id)];
  const open = all.filter((row) => row.state && !terminalMailState(row.state));
  receipts = [...open, ...all.filter((row) => (!row.state || terminalMailState(row.state)) && now - row.finishedAt <= MAX_AGE).slice(0, 100)];
  try {
    writeFileAtomic(FILE, JSON.stringify(receipts, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist receipts", error);
  }
}

export const findDelegationReceipt = (id: string): DelegationReceipt | null => receipts.find((row) => row.id === id) ?? null;
export const receiptSnapshot = (): DelegationReceipt[] => [...receipts];
export const resetDelegationReceipts = (): void => { receipts = []; };

const receiptSchema = z.object({
  id: z.string().min(1), sourceThreadId: z.string(), toBotId: z.string(), toBotName: z.string(),
  status: z.enum(["done", "failed", "denied", "busy_gave_up", "dropped", "error", "queued", "running"]),
  finishedAt: z.number().finite(), result: z.string().optional(),
  kind: z.enum(["ask", "delegation"]).optional(), deliver: z.enum(["queued", "now"]).optional(),
  state: z.enum(["held", "ready", "approval", "dispatching", "running", "steered", "finishing", "done", "failed", "dropped", "refused", "deferred"]).optional(),
  source: z.object({ botId: z.string(), threadId: z.string(), turnId: z.string() }).optional(),
  target: z.object({ botId: z.string(), threadId: z.string().optional(), turnId: z.string().optional() }).optional(),
  seq: z.number().finite().optional(), fallback: z.string().optional(),
  publish: z.array(z.object({ threadId: z.string(), mailKey: z.string(), rowId: z.string().optional(), row: z.custom<NonNullable<DelegationReceipt["publish"]>[number]["row"]>((row) => !!row && typeof row === "object" && (row as { role?: string }).role === "bot").optional() })).optional(),
});

export function loadDelegationReceipts(): void {
  receipts = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      const parsed = receiptSchema.safeParse(value);
      if (!parsed.success) continue;
      const row = parsed.data;
      if (row.state && !terminalMailState(row.state) || Date.now() - row.finishedAt <= MAX_AGE) receipts.push(row);
    }
  } catch {}
}
