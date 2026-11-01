import { createHash } from "node:crypto";
import { z } from "zod";

export const REPORT_MAX_BYTES = 5 * 1024 * 1024;
export const REPORT_IMAGE_BYTES = 1024 * 1024;
export const REPORT_ID = /^[a-f0-9]{32}$/;
export const REPORT_OWNER = /^[a-f0-9]{64}$/;
const id = z.string().min(1).max(128);
const text = z.string().max(12_000);

export const reportImageSchema = z.strictObject({
  messageId: id,
  mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  base64: z.string().min(4).max(Math.ceil(REPORT_IMAGE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  sha256: z.string().regex(REPORT_OWNER),
  source: z.enum(["stored-message", "referenced-file"]),
  collectedAt: z.int().nonnegative(),
});
export const teamReportSchema = z.strictObject({
  id: z.string().regex(REPORT_ID),
  owner: z.string().regex(REPORT_OWNER),
  at: z.int().nonnegative(),
  bot: z.strictObject({ id, name: z.string().max(200) }),
  threadId: id,
  branchId: id,
  selectedMessageId: id,
  requestMessageId: id,
  summary: z.string().max(2000),
  diagnosis: z.string().max(2000),
  originals: z.array(z.strictObject({
    id, at: z.int().nonnegative(), role: z.enum(["user", "bot"]),
    speaker: z.string().max(200), kind: z.string().max(40),
    text, redacted: z.boolean(), truncated: z.boolean(),
  })).max(24),
  images: z.array(reportImageSchema).max(3),
  diagnostics: z.string().max(8000),
  incident: z.strictObject({ engine: z.literal("unknown"), model: z.literal("unknown"), version: z.literal("unknown") }),
  current: z.strictObject({ engine: z.string().max(120), model: z.string().max(200), version: z.string().max(80) }),
  missing: z.array(z.string().max(240)).max(32),
});
export type TeamReport = z.infer<typeof teamReportSchema>;

export const reportReceiptSchema = z.strictObject({
  id: z.string().regex(REPORT_ID),
  state: z.enum(["accepted", "filed"]),
  read: z.literal(false),
});
export type ReportReceipt = z.infer<typeof reportReceiptSchema>;

export function reportOwnerHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function reportPayload(owner: string, auth: { idToken: string; ticket: string; pk: string }, report: TeamReport): Buffer {
  return Buffer.from(JSON.stringify(["wink-team-report/1", owner, auth.idToken, auth.ticket, auth.pk, report]));
}
