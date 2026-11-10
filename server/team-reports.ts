import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isVoiceLine } from "../shared/live-call.ts";
import type { PhoneRelayStatus } from "../shared/relay-protocol.ts";
import { REPORT_ID, teamReportSchema, type ReportReceipt, type TeamReport } from "../shared/team-report.ts";
import { writeFileAtomic } from "./atomic.ts";
import { collectReport, REPORT_CHECKLIST, reportText } from "./team-report-evidence.ts";
import { reportIntent, teamReportPrompt, TEAM_REPORT_RULE } from "./team-report-intent.ts";
import { ReportRefusal } from "./team-report-transport.ts";
import type { Store } from "./store.ts";

const requestSchema = z.strictObject({
  fromBotId: z.string().min(1).max(128), fromThreadId: z.string().min(1).max(128),
  action: z.enum(["collect", "send", "draft", "retry"]),
  report_id: z.string().regex(REPORT_ID).optional(),
  selected_message_id: z.string().min(1).max(128).optional(),
  earlier_message_ids: z.array(z.string().min(1).max(128)).max(8).optional(),
  exclude_image_message_ids: z.array(z.string().min(1).max(128)).max(24).optional(),
  summary: z.string().max(2000).optional(), diagnosis: z.string().max(2000).optional(),
});

export interface TeamReportsOptions {
  dir: string;
  store: Pick<Store, "conversationForBot" | "bot" | "activePath">;
  status(): PhoneRelayStatus;
  enrolled(): boolean;
  owner: string | null;
  attachmentsDir: string;
  roots(botId: string, threadId: string): string[];
  current(botId: string): TeamReport["current"];
  send(report: TeamReport): Promise<ReportReceipt>;
}

export class TeamReports {
  private readonly options: TeamReportsOptions;
  private readonly sending = new Set<string>();

  constructor(options: TeamReportsOptions) { this.options = options; }

  prompt(): string {
    const o = this.options;
    const rule = teamReportPrompt(o.status(), o.owner);
    if (rule && o.enrolled()) {
      try {
        mkdirSync(o.dir, { recursive: true, mode: 0o700 });
        const file = join(o.dir, "membership.json");
        let saved: string | undefined;
        try { saved = JSON.parse(readFileSync(file, "utf8")).owner; } catch {}
        if (saved !== o.owner) writeFileAtomic(file, JSON.stringify({ owner: o.owner }), { mode: 0o600 });
      } catch {}
      return rule;
    }
    return o.status().state !== "connected" && this.canDraft() ? TEAM_REPORT_RULE : "";
  }

  private canDraft(): boolean {
    const o = this.options;
    const status = o.status();
    if (!o.enrolled() || status.state === "rejected" || (status.reportOwner && status.reportOwner !== o.owner)) return false;
    if (teamReportPrompt(status, o.owner)) return true;
    try { return JSON.parse(readFileSync(join(o.dir, "membership.json"), "utf8")).owner === o.owner && Boolean(o.owner); } catch { return false; }
  }

  async handle(raw: unknown): Promise<Record<string, unknown>> {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return { error: "Invalid report request." };
    const body = parsed.data;
    const o = this.options;
    const bot = o.store.bot(body.fromBotId);
    if (!bot || !o.store.conversationForBot(bot.id, body.fromThreadId)) return { error: "Report conversation does not belong to sender." };
    this.prompt();
    if (!this.canDraft()) return { error: "Authenticated team reporting unavailable. No report sent." };
    const path = o.store.activePath(body.fromThreadId);
    const request = path.findLast((message) => message.role === "user" && message.kind === "text");
    if (!request || request.comm || request.from || request.queued || /(?:UNTRUSTED WEBHOOK|AUTHENTICATED WEBHOOK)/i.test(request.text ?? "")) return { error: "A direct user report request is required." };
    if (reportIntent(request.text ?? "") !== "send") return { error: "No report call phrase. No report sent." };
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const contextFile = join(o.dir, `context-${createHash("sha256").update(JSON.stringify([bot.id, body.fromThreadId])).digest("hex")}.json`);
    let context: { requestId: string; reportId?: string } | undefined;
    try { context = z.strictObject({ requestId: z.string(), reportId: z.string().regex(REPORT_ID).optional() }).parse(JSON.parse(readFileSync(contextFile, "utf8"))); } catch {}
    const anchor = path.find((message) => message.id === context?.requestId);
    const newIncident = anchor && (anchor.id !== request.id || (body.report_id && body.report_id !== context?.reportId))
      && (request.image || request.png || /<attached-(?:image|file)\b/i.test(request.text ?? ""));
    const savedId = newIncident ? undefined : body.report_id ?? (anchor ? context?.reportId : undefined);
    let previous: { report: TeamReport; receipt?: ReportReceipt } | undefined;
    if (savedId) {
      try { previous = JSON.parse(readFileSync(join(o.dir, `${savedId}.json`), "utf8")); } catch {}
      if (!previous) return { error: "Saved report unavailable; collect this incident first." };
      try { previous.report = teamReportSchema.parse(previous.report); } catch { return { error: "Saved report invalid." }; }
      const ids = new Set(path.map((message) => message.id));
      const saved = previous.report;
      if (saved.owner !== o.owner || !o.store.conversationForBot(saved.bot.id, body.fromThreadId) || saved.threadId !== body.fromThreadId || !ids.has(saved.requestMessageId) || !ids.has(saved.selectedMessageId) || !saved.originals.every((message) => ids.has(message.id))) return { error: "Saved report does not belong to this branch/sender/team." };
    }
    if (!body.report_id && body.action !== "retry" && previous?.receipt && request.id !== previous.report.requestMessageId) previous = undefined;
    let report: TeamReport;
    if (!previous) writeFileAtomic(contextFile, JSON.stringify({ requestId: request.id }), { mode: 0o600 });
    try {
      if (previous && !previous.receipt && body.action !== "retry" && (body.selected_message_id || body.earlier_message_ids)) {
        const saved = previous.report;
        const selected = body.selected_message_id ?? saved.selectedMessageId;
        const index = path.findIndex((message) => message.id === selected);
        previous.report = { ...collectReport({ owner: o.owner!, bot, threadId: body.fromThreadId, path,
          request: path.find((message) => message.id === saved.requestMessageId)!, selectedMessageId: selected,
          earlierMessageIds: body.earlier_message_ids ?? saved.originals.filter((message) => path.findIndex((entry) => entry.id === message.id) < index).slice(-8).map((message) => message.id),
          excludeImageMessageIds: [...(body.exclude_image_message_ids ?? []), ...saved.missing.flatMap((note) => /^Images on (.+) excluded as sensitive or unrelated\.$/.exec(note)?.[1] ?? [])],
          attachmentsDir: o.attachmentsDir, roots: o.roots(bot.id, body.fromThreadId), current: o.current(bot.id) }),
          id: saved.id, summary: saved.summary, diagnosis: saved.diagnosis };
      }
      report = previous ? previous.report : collectReport({ owner: o.owner!, bot, threadId: body.fromThreadId, path, request,
        selectedMessageId: body.selected_message_id, earlierMessageIds: body.earlier_message_ids,
        excludeImageMessageIds: body.exclude_image_message_ids,
        attachmentsDir: o.attachmentsDir, roots: o.roots(bot.id, body.fromThreadId), current: o.current(bot.id) });
    } catch (error) { return { error: (error as Error).message }; }
    const file = join(o.dir, `${report.id}.json`);
    if (!previous) { try { previous = JSON.parse(readFileSync(file, "utf8")); } catch {} }
    if (body.action === "retry" && !previous) return { error: "Saved report unavailable; collect this incident first." };
    if (previous && (body.action === "retry" || (body.action === "send" && !body.earlier_message_ids && !body.exclude_image_message_ids))) {
      report = teamReportSchema.parse(previous.report);
      const ids = new Set(path.map((message) => message.id));
      if (report.owner !== o.owner || !o.store.conversationForBot(report.bot.id, body.fromThreadId) || report.threadId !== body.fromThreadId || !ids.has(report.requestMessageId) || !report.originals.every((message) => ids.has(message.id))) return { error: "Saved report does not belong to this branch/sender/team." };
    }
    if (body.action !== "retry") {
      report.summary = reportText(body.summary ?? report.summary).slice(0, 2000);
      report.diagnosis = reportText(body.diagnosis ?? report.diagnosis).slice(0, 2000);
    }
    if (previous?.receipt && body.action !== "retry") return { ...previous.receipt, text: receiptText(previous.receipt) };
    if (body.exclude_image_message_ids?.length) {
      const excluded = new Set(body.exclude_image_message_ids);
      const notes = [...excluded].filter((id) => report.images.some((image) => image.messageId === id)).map((id) => `Images on ${id} excluded as sensitive or unrelated.`);
      report = { ...report, images: report.images.filter((image) => !excluded.has(image.messageId)), missing: [...new Set([...notes, ...report.missing])].slice(0, 32) };
    }
    const save = (receipt?: ReportReceipt) => writeFileAtomic(join(o.dir, `${report.id}.json`), JSON.stringify({ report, ...(receipt ? { receipt } : {}) }), { mode: 0o600 });
    save(previous?.receipt);
    writeFileAtomic(contextFile, JSON.stringify({ requestId: report.requestMessageId, reportId: report.id }), { mode: 0o600 });
    if (body.action === "collect" || body.action === "draft") {
      return { id: report.id, state: "draft", sent: false, checklist: REPORT_CHECKLIST,
        earlierReferences: path.slice(0, path.findIndex((message) => message.id === report.selectedMessageId)).filter((message) => message.role === "user" && message.kind === "text" && !message.comm && !isVoiceLine(message)).slice(-8).map((message) => ({ id: message.id, text: reportText(message.text ?? "").slice(0, 360) })),
        recentAnswers: path.slice(0, path.indexOf(request)).filter((message) => message.role === "bot" && message.kind === "text" && !message.comm && !isVoiceLine(message)).slice(-8).map((message) => ({ id: message.id, text: reportText(message.text ?? "").slice(0, 360) })),
        report: { ...report, images: report.images.map(({ base64, ...image }) => ({ ...image, bytes: Buffer.from(base64, "base64").length })) } };
    }
    if (!teamReportPrompt(o.status(), o.owner)) return previous?.receipt
      ? { ...previous.receipt, text: `${receiptText(previous.receipt)} Relay unavailable for a receipt refresh.` }
      : { id: report.id, state: "unsent", text: "Relay offline or reporting unsupported. A private local draft is saved; no confirmed delivery." };
    if (this.sending.has(report.id)) return { id: report.id, state: "unsent", text: "Submission pending. Retry this same report ID for a receipt." };
    this.sending.add(report.id);
    try {
      const receipt = await o.send(report);
      save(receipt);
      return { ...receipt, text: receiptText(receipt) };
    } catch (error) {
      if (previous?.receipt) return { ...previous.receipt, text: `${receiptText(previous.receipt)} Receipt refresh failed.` };
      if (error instanceof ReportRefusal) return { id: report.id, state: "unsent", text: `Refused, not delivered: ${error.message}. A private local draft is saved.` };
      return { id: report.id, state: "unsent", text: "No confirmed delivery. A private local draft is saved; retry uses the same ID. The service may have accepted it if the connection failed after submission." };
    } finally { this.sending.delete(report.id); }
  }
}

function receiptText(receipt: ReportReceipt): string {
  return `${receipt.id}: ${receipt.state === "filed" ? "filed in the owner's private local inbox" : "accepted by the private team report service; local inbox filing unconfirmed"}. Owner bot reading is unverified.`;
}
