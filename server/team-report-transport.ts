import { sign } from "node:crypto";
import { reportPayload, reportReceiptSchema, type ReportReceipt, type TeamReport } from "../shared/team-report.ts";
import { readIdentity, readTicket, ticketProblem } from "./phone-relay/store.ts";
import { teamIdToken, teamRelayOrigin, type TeamTokenSource } from "./team-stats.ts";

export async function boundedReportJson(response: Response, max: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > max || !response.body) throw new Error("invalid report response size");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new Error("report response too large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface ReportTransportOptions {
  dataDir: string;
  base(): string | null;
  tokens: TeamTokenSource;
  fetchImpl?: typeof fetch;
}

export class ReportRefusal extends Error {}

export function hasReportEnrollment(dataDir: string, base: string | null): boolean {
  if (!base) return false;
  const identity = readIdentity(dataDir), ticket = readTicket(dataDir);
  return identity.kind === "ok" && ticket.kind === "ok" && !ticketProblem(ticket.value, identity.value, Date.now());
}

export async function sendTeamReport(options: ReportTransportOptions, report: TeamReport): Promise<ReportReceipt> {
  const origin = teamRelayOrigin(options.base(), null);
  const identity = readIdentity(options.dataDir);
  const ticket = readTicket(options.dataDir);
  if (!origin || identity.kind !== "ok" || ticket.kind !== "ok" || ticketProblem(ticket.value, identity.value, Date.now())) throw new Error("team enrollment unavailable");
  const idToken = await teamIdToken(options.tokens);
  if (!idToken) throw new Error("team account unavailable");
  const auth = { idToken, ticket: ticket.value, pk: identity.value.pk };
  const sig = sign(null, Buffer.from(JSON.stringify(["wink-relay-account/1", idToken, auth.ticket, auth.pk])), identity.value.privateKey).toString("base64url");
  const signature = sign(null, reportPayload(report.owner, auth, report), identity.value.privateKey).toString("base64url");
  const response = await (options.fetchImpl ?? fetch)(`${origin}/v1/team/reports/submit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth: { ...auth, sig }, signature, report }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if ((response.status >= 400 && response.status < 500) || response.status === 507) {
      let reason = `HTTP ${response.status}`;
      try {
        const body = await boundedReportJson(response, 2048) as { error?: unknown };
        if (typeof body.error === "string" && /^[a-z0-9-]{1,80}$/.test(body.error)) reason += ` ${body.error}`;
      } catch {}
      throw new ReportRefusal(reason);
    }
    throw new Error(`report service unavailable (${response.status})`);
  }
  const receipt = reportReceiptSchema.parse(await boundedReportJson(response, 2048));
  if (receipt.id !== report.id) throw new Error("report receipt ID mismatch");
  return receipt;
}
