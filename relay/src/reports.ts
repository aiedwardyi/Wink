import { createHash, verify } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { publicKeyFromRaw, LABEL_RE } from "../../shared/relay-protocol.ts";
import { REPORT_ID, REPORT_MAX_BYTES, reportOwnerHash, reportPayload, teamReportSchema, type ReportReceipt } from "../../shared/team-report.ts";
import { accountRequestSchema, type Accounts } from "./accounts.ts";
import { writeAtomic } from "./team.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { safeImageMetadata } from "../../shared/image-metadata.ts";

const envelopeSchema = z.strictObject({ auth: accountRequestSchema, signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/), report: teamReportSchema });
export const heldReportSchema = z.strictObject({
  report: teamReportSchema, label: z.string().regex(LABEL_RE), subHash: z.string().max(64),
  received: z.int().nonnegative(), filed: z.boolean(),
});
export type HeldReport = z.infer<typeof heldReportSchema>;
const storedReportSchema = heldReportSchema.extend({ lease: z.int().nonnegative().default(0) });
const filedReportSchema = z.strictObject({ id: z.string().regex(REPORT_ID), label: z.string().regex(LABEL_RE), subHash: z.string().max(64), received: z.int().nonnegative(), filed: z.literal(true) });
type StoredReport = z.infer<typeof storedReportSchema> | z.infer<typeof filedReportSchema>;
const STORE_BYTES = 64 * 1024 * 1024;
const REPORT_KEEP_MS = 14 * 86_400_000;
const entryId = (entry: StoredReport) => "report" in entry ? entry.report.id : entry.id;
const tombstone = (entry: StoredReport) => ({ id: entryId(entry), label: entry.label, subHash: entry.subHash, received: entry.received, filed: true as const });

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return redactSecretsInText(value) !== value || /\b(?:wkt1|wka1|wki1)\.[A-Za-z0-9_.-]+/.test(value);
  return value !== null && typeof value === "object" && Object.values(value).some(containsSecret);
}

export class ReportStore {
  private readonly dir: string;
  private readonly owner: string;
  private writes: Promise<unknown> = Promise.resolve();
  private held?: Map<string, StoredReport>;

  constructor(dir: string, ownerEmail: string) {
    this.dir = join(dir, "team-reports");
    this.owner = reportOwnerHash(ownerEmail);
  }

  private async entries(now: number): Promise<StoredReport[]> {
    if (!this.held) {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const held = new Map<string, StoredReport>();
      for (const name of await readdir(this.dir)) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        const file = join(this.dir, name);
        if ((await stat(file)).size > REPORT_MAX_BYTES) throw new Error("report store entry too large");
        let entry = z.union([storedReportSchema, filedReportSchema]).parse(JSON.parse(await readFile(file, "utf8")));
        if (entry.filed && "report" in entry) {
          entry = tombstone(entry);
          await writeAtomic(file, JSON.stringify(entry));
        }
        held.set(entryId(entry), entry);
      }
      this.held = held;
    }
    for (const [id, entry] of this.held) {
      if (entry.filed || entry.received > now - REPORT_KEEP_MS) continue;
      await rm(join(this.dir, `${id}.json`));
      this.held.delete(id);
    }
    return [...this.held.values()];
  }

  private async put(entry: StoredReport): Promise<void> {
    await writeAtomic(join(this.dir, `${entryId(entry)}.json`), JSON.stringify(entry));
    this.held!.set(entryId(entry), entry);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writes.then(fn);
    this.writes = result.catch(() => {});
    return result;
  }

  async submit(raw: unknown, accounts: Pick<Accounts, "register">, now: number): Promise<{ status: number; body: unknown }> {
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) return { status: 400, body: { error: "bad-report" } };
    const { auth, signature, report } = parsed.data;
    if (report.owner !== this.owner || Buffer.byteLength(JSON.stringify(report)) > REPORT_MAX_BYTES - 16_384) return { status: 403, body: { error: "wrong-team-or-size" } };
    const key = publicKeyFromRaw(auth.pk);
    if (!key || !verify(null, reportPayload(this.owner, auth, report), key, Buffer.from(signature, "base64url"))) return { status: 403, body: { error: "bad-report-signature" } };
    const identity = await accounts.register(auth);
    if (!identity.ok) return { status: identity.status, body: { error: identity.error } };
    if (containsSecret({ ...report, images: report.images.map(({ base64: _base64, ...image }) => image) })) return { status: 400, body: { error: "report-contains-secret" } };
    for (const image of report.images) {
      const bytes = Buffer.from(image.base64, "base64");
      const head = bytes.subarray(0, 12);
      const mime = head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "image/png"
        : head.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ? "image/jpeg"
        : /^GIF8[79]a/.test(head.toString("latin1")) ? "image/gif"
        : head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
      if (bytes.length > 1024 * 1024 || image.base64 !== bytes.toString("base64") || mime !== image.mime || createHash("sha256").update(bytes).digest("hex") !== image.sha256 || !safeImageMetadata(bytes, image.mime, redactSecretsInText)) return { status: 400, body: { error: "bad-image" } };
    }
    return this.serial(async () => {
      const entries = await this.entries(now);
      const existing = entries.find((entry) => entryId(entry) === report.id);
      if (existing && (existing.label !== identity.label || existing.subHash !== identity.subHash)) return { status: 409, body: { error: "report-id-owned" } };
      if (!existing) {
        const active = entries.filter((entry) => !entry.filed);
        const used = active.reduce((size, entry) => size + Buffer.byteLength(JSON.stringify(entry)), 0);
        if (used + Buffer.byteLength(JSON.stringify(report)) > STORE_BYTES || active.length >= 512) return { status: 507, body: { error: "report-store-full" } };
        const today = entries.filter((entry) => entry.label === identity.label && now - entry.received < 86_400_000);
        if (today.length >= 20) return { status: 429, body: { error: "report-limit" } };
        await this.put({ report, label: identity.label, subHash: identity.subHash, received: now, filed: false, lease: 0 });
      }
      const receipt: ReportReceipt = { id: report.id, state: existing?.filed ? "filed" : "accepted", read: false };
      return { status: 200, body: receipt };
    });
  }

  claim(now = Date.now()): Promise<HeldReport[]> {
    return this.serial(async () => {
      const entries = (await this.entries(now)).filter((entry): entry is z.infer<typeof storedReportSchema> => "report" in entry && !entry.filed && entry.lease <= now).sort((a, b) => a.received - b.received).slice(0, 1);
      for (const entry of entries) await this.put({ ...entry, lease: now + 10 * 60_000 });
      return entries.map(({ lease: _lease, ...held }) => held);
    });
  }

  ack(ids: string[], now = Date.now()): Promise<void> {
    return this.serial(async () => {
      for (const entry of await this.entries(now)) {
        if (ids.includes(entryId(entry))) await this.put(tombstone(entry));
      }
    });
  }

  async close(): Promise<void> { await this.writes; }
}

export const reportAckSchema = z.strictObject({ ids: z.array(z.string().regex(REPORT_ID)).max(1) });
