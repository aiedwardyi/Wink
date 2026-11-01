import type { IncomingMessage, ServerResponse } from "node:http";
import { REPORT_MAX_BYTES } from "../../shared/team-report.ts";
import type { Accounts } from "./accounts.ts";
import { silentLogger, type Logger } from "./log.ts";
import { reportAckSchema, type ReportStore } from "./reports.ts";

async function body(req: IncomingMessage, max: number): Promise<unknown> {
  if (Number(req.headers["content-length"]) > max) throw new Error("too-large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("too-large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function reportHttp(req: IncomingMessage, res: ServerResponse, options: {
  accounts: Accounts; reports: ReportStore; owner: string; now(): number;
  who?(label: string): { name: string; person: string };
  log?: Logger;
}): Promise<void> {
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(data));
  };
  if (req.method !== "POST") return send(405, { error: "method" });
  try {
    if (req.url === "/v1/team/reports/submit") {
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) return send(415, { error: "content-type" });
      const result = await options.reports.submit(await body(req, REPORT_MAX_BYTES), options.accounts, options.now());
      return send(result.status, result.body);
    }
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "");
    if (!match) return send(401, { error: "bad-token" });
    const who = await options.accounts.owner(match[1]!, options.owner);
    if (!who.ok) return send(who.status, { error: who.error });
    if (req.url === "/v1/team/reports/claim") return send(200, { reports: (await options.reports.claim(options.now())).map((held) => ({ ...held, pc: { label: held.label, ...(options.who?.(held.label) ?? { name: held.label, person: "" }) } })) });
    if (req.url === "/v1/team/reports/ack") {
      const ack = reportAckSchema.safeParse(await body(req, 2048));
      if (!ack.success) return send(400, { error: "bad-ack" });
      await options.reports.ack(ack.data.ids, options.now());
      return send(200, { filed: true });
    }
    return send(404, { error: "not-found" });
  } catch (error) {
    const invalid = error instanceof SyntaxError || (error instanceof Error && error.message === "too-large");
    if (!invalid) (options.log ?? silentLogger).log("reports-error", { route: req.url?.split("/").at(-1), reason: "unexpected" });
    return send(invalid ? 400 : 503, { error: invalid ? "bad-report-body" : "report-store-unavailable" });
  }
}
