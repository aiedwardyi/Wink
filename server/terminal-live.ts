import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { json, readBody } from "./http-helpers.ts";
import { terminalInputGrant, terminalReadGrant } from "./terminal-grant.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

const BATCH_MS = 5;
const HEARTBEAT_MS = 15_000;
const LEASE_MS = 150_000;
// A browser this far behind reattaches from the host's ring instead.
const BACKLOG_LIMIT = 1024 * 1024;

const session = { sessionId: z.string().min(1).max(128), generation: z.number().int() };
const inputSchema = z.object({ ...session, data: z.string().min(1).max(64 * 1024) });
const resizeSchema = z.object({ ...session, cols: z.number().int(), rows: z.number().int() });
const leaseSchema = z.object({ lease: z.string().min(1).max(64) });
const frameSchema = z.object({
  seq: z.number().optional(),
  data: z.string().optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  exitCode: z.number().nullable().optional(),
}).catch({});
const errorSchema = z.object({ error: z.string().optional() }).catch({});

export type TerminalLiveDeps = {
  access: () => TerminalBridgeAccess | null;
  /** True for a bot's own bearer; live keys are for a person at a browser. */
  botCaller: (authorization: string | undefined) => boolean;
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  leaseMs?: number;
};

async function bridgeError(res: Response): Promise<{ status: number; body: { error: string } }> {
  const { error } = errorSchema.parse(await res.json().catch(() => ({})));
  if (res.status === 404 || /unknown terminal/i.test(error ?? "")) return { status: 404, body: { error: "Unknown terminal" } };
  if (res.status === 409 || res.status === 400) return { status: res.status, body: { error: error ?? `terminal bridge: HTTP ${res.status}` } };
  return { status: 502, body: { error: `terminal bridge: HTTP ${res.status}` } };
}

/** Live bot terminals for browsers: SSE down from the bridge stream, keys and size up by POST. */
export function createTerminalLive(deps: TerminalLiveDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const leases = new Map<string, { botId: string; renew: () => void }>();

  async function live(res: ServerResponse, access: TerminalBridgeAccess, botId: string, sessionId: string | null): Promise<void> {
    const abort = new AbortController();
    const lease = randomUUID();
    let heartbeat: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    let batch: NodeJS.Timeout | undefined;
    const stop = () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      clearTimeout(batch);
      leases.delete(lease);
      abort.abort();
      if (!res.writableEnded) res.end();
    };
    res.once("close", stop);
    const qs = sessionId ? `?${new URLSearchParams({ sessionId })}` : "";
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal/stream${qs}`, {
        headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}` },
        signal: abort.signal,
      });
    } catch {
      if (!abort.signal.aborted) json(res, 502, { error: "terminal bridge unreachable" });
      return;
    }
    if (abort.signal.aborted) return;
    if (!upstream.ok || !upstream.body) {
      const failed = await bridgeError(upstream);
      return json(res, failed.status, failed.body);
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.socket?.setTimeout(0);
    const closed = () => res.writableEnded || res.destroyed;
    const send = (frame: string, id?: number) => {
      if (closed()) return;
      res.write(`${id === undefined ? "" : `id: ${id}\n`}data: ${frame}\n\n`);
      if (res.writableLength > BACKLOG_LIMIT) res.destroy();
    };
    let pending = "";
    let pendingSeq = 0;
    const flush = () => {
      clearTimeout(batch);
      batch = undefined;
      if (!pending) return;
      send(JSON.stringify({ kind: "output", seq: pendingSeq, data: pending }), pendingSeq);
      pending = "";
    };
    const renew = () => {
      clearTimeout(expiry);
      expiry = setTimeout(stop, deps.leaseMs ?? LEASE_MS);
    };
    leases.set(lease, { botId, renew });
    renew();
    heartbeat = setInterval(() => res.write(`: keepalive\n\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`), deps.heartbeatMs ?? HEARTBEAT_MS);
    const decoder = new TextDecoder();
    let buffered = "";
    let first = true;
    try {
      for await (const chunk of upstream.body) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line || closed()) continue;
          if (first) {
            first = false;
            const snapshot = z.record(z.string(), z.unknown()).catch({}).parse(JSON.parse(line));
            send(JSON.stringify({ kind: "snapshot", lease, ...snapshot }), z.number().catch(0).parse(snapshot.seq));
            continue;
          }
          const frame = frameSchema.parse(JSON.parse(line));
          if (frame.data !== undefined && frame.seq !== undefined) {
            pending += frame.data;
            pendingSeq = frame.seq;
            batch ??= setTimeout(flush, BATCH_MS);
          } else if (frame.cols !== undefined && frame.rows !== undefined) {
            flush();
            send(JSON.stringify({ kind: "resize", cols: frame.cols, rows: frame.rows }));
          } else if (frame.exitCode !== undefined) {
            flush();
            send(JSON.stringify({ kind: "exit", exitCode: frame.exitCode }));
          }
        }
      }
    } catch {}
    flush();
    stop();
  }

  async function forward(res: ServerResponse, access: TerminalBridgeAccess, botId: string, route: "input" | "resize", body: z.infer<typeof inputSchema> | z.infer<typeof resizeSchema>): Promise<void> {
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal/${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${terminalInputGrant(access.token, botId)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return json(res, 502, { error: "terminal bridge unreachable" });
    }
    if (!upstream.ok) {
      const failed = await bridgeError(upstream);
      return json(res, failed.status, failed.body);
    }
    return json(res, 200, route === "input" ? { sent: true } : { resized: true });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, botId: string, route: string, url: URL): Promise<void> {
    if (deps.botCaller(req.headers.authorization)) return json(res, 403, { error: "forbidden" });
    const method = req.method ?? "GET";
    if (method !== (route === "live" ? "GET" : "POST")) return json(res, 405, { error: "method not allowed" });
    if (route === "lease") {
      const parsed = leaseSchema.safeParse(await readBody(req));
      const held = parsed.success ? leases.get(parsed.data.lease) : undefined;
      if (!held || held.botId !== botId) return json(res, 404, { error: "no such stream" });
      held.renew();
      return json(res, 200, { ok: true });
    }
    const access = deps.access();
    if (route === "live") {
      if (!access) return json(res, 503, { error: "terminal bridge unavailable" });
      return live(res, access, botId, url.searchParams.get("sessionId"));
    }
    const parsed = (route === "input" ? inputSchema : resizeSchema).safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: route === "input" ? "sessionId, generation and data are required" : "sessionId, generation, cols and rows are required" });
    if (!access) return json(res, 503, { error: "terminal bridge unavailable" });
    return forward(res, access, botId, route === "input" ? "input" : "resize", parsed.data);
  }

  return { handle };
}
