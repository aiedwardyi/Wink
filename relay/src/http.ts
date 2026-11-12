// relay.<base> HTTP API over the outer TLS, ALPN http/1.1 (design sections 4 and 7):
// GET /v1/healthz, GET /v1/status/<label>, POST /v1/enroll,
// and, when config.google is set, POST /v1/account and GET /v1/pcs,
// plus GET /v1/team and POST /v1/team/snags/{claim,ack} when teamOwnerEmail is set too,
// GET /v1/room-codes/<code>,
// and, when config.stats is set, POST /v1/stats and GET /v1/stats/day/<date>.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { z } from "zod";
import { LABEL_RE, ROOM_CODE_RE, SNAG_ID_RE, hostFor } from "../../shared/relay-protocol.ts";
import { STATS_MAX_BYTES, STATS_MAX_INFLATED } from "../../shared/usage-stats.ts";
import { BAD_ACCOUNT_REQUEST, accountRequestSchema, type Accounts } from "./accounts.ts";
import { BAD_REQUEST, enrollRequestSchema, type Enroller } from "./enroll.ts";
import type { Hub } from "./hub.ts";
import { RateLimiter, type RelayLimits } from "./limits.ts";
import type { Logger } from "./log.ts";
import { peerPrefix, rateKey } from "./net-util.ts";
import { SNAG_CLAIM_MAX, type SnagStore } from "./snags.ts";
import type { TeamLog } from "./team.ts";
import type { ReportStore } from "./reports.ts";
import { reportHttp } from "./reports-http.ts";
import type { RoomCodeStore } from "./room-codes.ts";
import type { StatsStore } from "./stats.ts";

export interface ApiOptions {
  base: string;
  relayHost: string;
  hub: Hub;
  enroller: Enroller;
  /** Set together. Without them, /v1/account and /v1/pcs are 404. */
  accounts?: Accounts;
  signinOrigin?: string;
  /** Set together, and only with `accounts`. Without them, /v1/team is 404. */
  team?: TeamLog;
  teamOwnerEmail?: string;
  /** Set with `team`. */
  snags?: SnagStore;
  reports?: ReportStore;
  roomCodes?: RoomCodeStore;
  /** Without it, /v1/stats is 404. */
  stats?: StatsStore;
  limits: RelayLimits;
  log: Logger;
  now: () => number;
}

const ACCOUNT_MAX_BODY = 16 * 1024;

const STATUS_RE = /^\/v1\/status\/([^/?#]{1,64})$/;
const ROOM_CODE_URL_RE = /^\/v1\/room-codes\/([^/?#]{1,16})$/;
/** tz: the viewer's UTC offset in minutes, east positive. */
const TEAM_RE = /^\/v1\/team(?:\?tz=(-?[0-9]{1,4}))?$/;
const SNAGS_RE = /^\/v1\/team\/snags\/(claim|ack)$/;
const SNAG_ACK_MAX_BODY = 16 * 1024;
const STATS_DAY_RE = /^\/v1\/stats\/day\/(\d{4}-\d{2}-\d{2})$/;
const inflate = promisify(gunzip);
const snagAckSchema = z.object({ ids: z.array(z.string().regex(SNAG_ID_RE)).max(SNAG_CLAIM_MAX) });

type ReplyBody = Record<string, string | number | boolean | null>;

function sendJson(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function reply(res: ServerResponse, status: number, body: ReplyBody, headers: Record<string, string> = {}): void {
  sendJson(res, status, JSON.stringify(body), headers);
}

function replyEmpty(res: ServerResponse, status: number, headers: Record<string, string>): void {
  res.writeHead(status, { "cache-control": "no-store", "content-length": "0", ...headers });
  res.end();
}

function headerOne(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The JWT only. Anything else, including a token glued to extra text, is refused. */
function bearer(value: string | undefined): string | null {
  if (!value || value.length > 9000) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(value);
  return match?.[1] ?? null;
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", () => resolve(null));
  });
}

export function createApiServer(opts: ApiOptions): Server {
  const { hub, limits, log } = opts;
  const enrollLimit = RateLimiter.perHour(limits.enrollPerIpPerHour, opts.now);
  const accountLimit = RateLimiter.perHour(limits.accountPerIpPerHour, opts.now);
  const pcsLimit = RateLimiter.perMinute(limits.pcsPerIpPerMin, opts.now);
  const statusLimit = RateLimiter.perMinute(limits.statusPerIpPerMin, opts.now);
  const teamLimit = RateLimiter.perMinute(limits.pcsPerIpPerMin, opts.now);
  const roomCodeMinute = RateLimiter.perMinute(limits.roomCodeLookupsPerIpPerMin, opts.now);
  const roomCodeHour = RateLimiter.perHour(limits.roomCodeLookupsPerIpPerHour, opts.now);
  const roomCodeAll = RateLimiter.perHour(limits.roomCodeLookupsPerHour, opts.now);
  const statsLimit = RateLimiter.perHour(limits.statsPerIpPerHour, opts.now);
  const statsReadLimit = RateLimiter.perMinute(limits.pcsPerIpPerMin, opts.now);
  const { accounts, signinOrigin, team, teamOwnerEmail, snags, stats } = opts;

  function directoryCors(origin: string | undefined) {
    const headers: Record<string, string> = {};
    headers.vary = "Origin";
    if (signinOrigin && origin === signinOrigin) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-headers"] = "Authorization";
      headers["access-control-allow-methods"] = "GET";
    }
    return headers;
  }

  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000, maxHeaderSize: 8 * 1024, keepAliveTimeout: 5_000 },
    (req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 500, { error: "internal" });
        else res.destroy();
      });
    },
  );
  server.maxRequestsPerSocket = 100;
  server.setTimeout(5_000);
  // Handed-off sockets need Node's parser deadline tracker before the first connection.
  server.emit("listening");

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:443$/, "");
    if (host !== opts.relayHost) {
      reply(res, 421, { error: "misdirected" });
      return;
    }
    const url = req.url ?? "";
    const ip = rateKey(req.socket.remoteAddress);

    if (url === "/v1/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method" });
      return reply(res, 200, { ok: true });
    }

    const status = STATUS_RE.exec(url);
    if (status) {
      if (req.method !== "GET") return reply(res, 405, { error: "method" });
      if (!statusLimit.take(ip)) return reply(res, 429, { error: "rate-limited" });
      const label = status[1];
      if (!LABEL_RE.test(label)) return reply(res, 404, { error: "not-found" });
      // Only the label's own origin may read this cross-origin (the phone offline page).
      const origin = req.headers.origin;
      const cors: Record<string, string> = {};
      cors.vary = "Origin";
      if (origin === `https://${hostFor(label, opts.base)}`) cors["access-control-allow-origin"] = origin;
      const { online, since } = hub.status(label);
      return reply(res, 200, { online, since }, cors);
    }

    const roomCode = opts.roomCodes && ROOM_CODE_URL_RE.exec(url);
    if (roomCode) {
      if (req.method !== "GET") return reply(res, 405, { error: "method" });
      if (!roomCodeMinute.take(ip) || !roomCodeHour.take(ip) || !roomCodeAll.take("all")) return reply(res, 429, { error: "rate-limited" });
      const label = ROOM_CODE_RE.test(roomCode[1]) ? opts.roomCodes!.lookup(roomCode[1]) : null;
      return label ? reply(res, 200, { label }) : reply(res, 404, { error: "not-found" });
    }

    if (url === "/v1/enroll") {
      if (req.method !== "POST") return reply(res, 405, { error: "method" });
      if (!enrollLimit.take(ip)) {
        log.log("enroll-rejected", { peer: peerPrefix(req.socket.remoteAddress), reason: "rate-limited" });
        return reply(res, 429, { error: "rate-limited" });
      }
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) {
        return reply(res, 415, { error: "content-type" });
      }
      const body = await readBody(req, limits.maxBodyBytes);
      if (!body) return reply(res, 413, { error: "too-large" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return reply(res, 400, { error: "bad-request" });
      }
      const request = enrollRequestSchema.safeParse(parsed);
      const result = request.success ? await opts.enroller.enroll(request.data) : BAD_REQUEST;
      if (!result.ok) {
        log.log("enroll-rejected", { peer: peerPrefix(req.socket.remoteAddress), reason: result.error });
        return reply(res, result.status, { error: result.error });
      }
      log.log("enrolled", { label: result.label, peer: peerPrefix(req.socket.remoteAddress) });
      return reply(res, 200, { ticket: result.ticket });
    }

    if (stats && url === "/v1/stats") {
      if (req.method !== "POST") return reply(res, 405, { error: "method" });
      if (!statsLimit.take(ip)) return reply(res, 429, { error: "rate-limited" });
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) return reply(res, 415, { error: "content-type" });
      const sent = await readBody(req, STATS_MAX_BYTES);
      if (!sent) return reply(res, 413, { error: "too-large" });
      let parsed: unknown;
      try {
        const body = req.headers["content-encoding"] === "gzip" ? await inflate(sent, { maxOutputLength: STATS_MAX_INFLATED }) : sent;
        parsed = JSON.parse(body.toString("utf8"));
      } catch (error) {
        // SAFETY: zlib rejects with Node errno errors; a SyntaxError has no code.
        const large = (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
        return reply(res, large ? 413 : 400, { error: large ? "too-large" : "bad-request" });
      }
      const result = await stats.submit(parsed);
      return reply(res, result.status, result.body);
    }

    const statsDay = stats && STATS_DAY_RE.exec(url);
    if (stats && statsDay) {
      if (req.method !== "GET") return reply(res, 405, { error: "method" });
      const peer = peerPrefix(req.socket.remoteAddress);
      if (!statsReadLimit.take(ip)) {
        log.log("stats-read-rejected", { peer, reason: "rate-limited" });
        return reply(res, 429, { error: "rate-limited" });
      }
      const key = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(headerOne(req.headers.authorization) ?? "")?.[1];
      if (!key || !stats.allows(key)) {
        log.log("stats-read-rejected", { peer, reason: "bad-key" });
        return reply(res, 401, { error: "bad-key" });
      }
      const day = await stats.read(statsDay[1]);
      if (!day) return reply(res, 404, { error: "not-found" });
      res.writeHead(200, { "content-type": "application/x-ndjson", "content-encoding": "gzip", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      return pipeline(day, res);
    }

    if (accounts && signinOrigin && url === "/v1/account") {
      if (req.method !== "POST") return reply(res, 405, { error: "method" });
      const peer = peerPrefix(req.socket.remoteAddress);
      if (!accountLimit.take(ip)) {
        log.log("account-rejected", { peer, reason: "rate-limited" });
        return reply(res, 429, { error: "rate-limited" });
      }
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) {
        return reply(res, 415, { error: "content-type" });
      }
      const body = await readBody(req, ACCOUNT_MAX_BODY);
      if (!body) return reply(res, 413, { error: "too-large" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return reply(res, 400, { error: "bad-request" });
      }
      const request = accountRequestSchema.safeParse(parsed);
      const result = request.success ? await accounts.register(request.data) : BAD_ACCOUNT_REQUEST;
      if (!result.ok) {
        log.log("account-rejected", { peer, reason: result.error });
        return reply(res, result.status, { error: result.error });
      }
      log.log("account-issued", { label: result.label, subHash: result.subHash, peer });
      return reply(res, 200, { account: result.account });
    }

    if (accounts && signinOrigin && url === "/v1/pcs") {
      const origin = headerOne(req.headers.origin);
      const cors = directoryCors(origin);
      const peer = peerPrefix(req.socket.remoteAddress);
      if (req.method !== "GET" && req.method !== "OPTIONS") return reply(res, 405, { error: "method" }, cors);
      if (req.method === "OPTIONS") return replyEmpty(res, 204, cors);
      if (!pcsLimit.take(ip)) {
        log.log("pcs-rejected", { peer, reason: "rate-limited" });
        return reply(res, 429, { error: "rate-limited" }, cors);
      }
      const token = bearer(headerOne(req.headers.authorization));
      if (!token) return reply(res, 401, { error: "bad-token" }, cors);
      const who = await accounts.identity(token);
      if (!who.ok) {
        log.log("pcs-rejected", { peer, reason: who.error });
        return reply(res, who.status, { error: who.error }, cors);
      }
      return sendJson(res, 200, JSON.stringify(hub.pcsFor(who.subHash)), cors);
    }

    const today = url === "/v1/team/today" && snags && opts.reports;
    const teamUrl = TEAM_RE.exec(url) ?? (today ? [url] : null);
    if (accounts && signinOrigin && team && teamOwnerEmail && teamUrl) {
      const cors = directoryCors(headerOne(req.headers.origin));
      const peer = peerPrefix(req.socket.remoteAddress);
      if (req.method !== "GET" && req.method !== "OPTIONS") return reply(res, 405, { error: "method" }, cors);
      if (req.method === "OPTIONS") return replyEmpty(res, 204, cors);
      if (!teamLimit.take(ip)) {
        log.log("team-rejected", { peer, reason: "rate-limited" });
        return reply(res, 429, { error: "rate-limited" }, cors);
      }
      const tz = Number(teamUrl[1] ?? 0);
      if (Math.abs(tz) > 14 * 60) return reply(res, 400, { error: "bad-request" }, cors);
      const token = bearer(headerOne(req.headers.authorization));
      if (!token) return reply(res, 401, { error: "bad-token" }, cors);
      const who = await accounts.owner(token, teamOwnerEmail);
      if (!who.ok) {
        log.log("team-rejected", { peer, reason: who.error });
        return reply(res, who.status, { error: who.error }, cors);
      }
      if (today) {
        const now = opts.now();
        const start = Math.floor((now + 9 * 3_600_000) / 86_400_000) * 86_400_000 - 9 * 3_600_000;
        return sendJson(res, 200, JSON.stringify({ start, snags: snags.countToday(now), bugs: await opts.reports!.countToday(now) }), cors);
      }
      return sendJson(res, 200, JSON.stringify(team.stats(tz)), cors);
    }

    if (/^\/v1\/team\/reports\/(submit|claim|ack)$/.test(url) && accounts && teamOwnerEmail && opts.reports) {
      if (!teamLimit.take(ip)) return reply(res, 429, { error: "rate-limited" });
      return reportHttp(req, res, { accounts, reports: opts.reports, owner: teamOwnerEmail, now: opts.now, log, who: team ? (label) => team.who(label) : undefined });
    }
    const snagsUrl = SNAGS_RE.exec(url);
    if (accounts && signinOrigin && team && teamOwnerEmail && snags && snagsUrl) {
      const peer = peerPrefix(req.socket.remoteAddress);
      if (req.method !== "POST") return reply(res, 405, { error: "method" });
      if (!teamLimit.take(ip)) {
        log.log("snags-rejected", { peer, reason: "rate-limited" });
        return reply(res, 429, { error: "rate-limited" });
      }
      const token = bearer(headerOne(req.headers.authorization));
      if (!token) return reply(res, 401, { error: "bad-token" });
      const who = await accounts.owner(token, teamOwnerEmail);
      if (!who.ok) {
        log.log("snags-rejected", { peer, reason: who.error });
        return reply(res, who.status, { error: who.error });
      }
      if (snagsUrl[1] === "claim") {
        const claimed = snags.claim().map(({ label, snag }) => ({ ...snag, pc: { label, ...team.who(label) } }));
        log.log("snags-claimed", { count: claimed.length });
        return sendJson(res, 200, JSON.stringify({ snags: claimed }));
      }
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) return reply(res, 415, { error: "content-type" });
      const body = await readBody(req, SNAG_ACK_MAX_BODY);
      if (!body) return reply(res, 413, { error: "too-large" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return reply(res, 400, { error: "bad-request" });
      }
      const ack = snagAckSchema.safeParse(parsed);
      if (!ack.success) return reply(res, 400, { error: "bad-request" });
      const removed = snags.ack(ack.data.ids);
      log.log("snags-acked", { count: removed });
      return reply(res, 200, { acked: removed });
    }

    reply(res, 404, { error: "not-found" });
  }

  return server;
}
