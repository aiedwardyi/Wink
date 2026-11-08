// Phone open timings (src/lib/cold-open-timing.ts), kept on this PC only and never synced.
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { startupTiming } from "./startup-timing.ts";

export const COLD_OPEN_FILE = join("diag", "cold-open.jsonl");
export const COLD_OPEN_MAX_BYTES = 8 * 1024;
export const COLD_OPEN_KEEP = 200;

// The phone sends these names (src/lib/cold-open-timing.ts) on its first bots and stream requests.
const COLD_OPEN_HEADER = "x-cold-open";
const COLD_OPEN_QUERY = "coldOpen";
const OPEN_ID = /^[0-9a-f]{16}$/;
const OPEN_IDS_KEPT = 32;
const SERVER_START = new Date(Date.now() - process.uptime() * 1000).toISOString();

const ms = z.number().finite();
const size = z.number().int().nonnegative();
const request = z.object({ start: ms, end: ms, transferSize: size, encodedBodySize: size }).strict();
const botsRequest = z
  .object({
    start: ms,
    end: ms,
    transferSize: size,
    encodedBodySize: size,
    requestStart: ms.optional(),
    responseStart: ms.optional(),
    decodedBodySize: size.optional(),
    nextHopProtocol: z.string().max(16).optional(),
  })
  .strict();
const sse = z.object({ created: ms, open: ms.optional(), errors: size, lastError: ms.optional() }).strict();
const cache = z.object({ hit: z.boolean(), paint: ms.optional() }).strict();
const server = z.object({ botsMs: ms, sseClients: size, uptimeS: size }).partial().strict();
const nav = z
  .object({
    fetchStart: ms,
    connectStart: ms,
    connectEnd: ms,
    secureConnectionStart: ms,
    requestStart: ms,
    responseStart: ms,
    responseEnd: ms,
    domInteractive: ms,
    domContentLoadedEventEnd: ms,
  })
  .partial()
  .strict();

export const coldOpenRecordSchema = z
  .object({
    desktop: z.literal(true).optional(),
    openId: z.string().regex(OPEN_ID).optional(),
    label: z.enum(["notification", "open", "warm", "resume"]),
    t0: ms.optional(),
    hiddenMs: ms.optional(),
    nav: nav.optional(),
    firstPaint: ms.optional(),
    firstContentfulPaint: ms.optional(),
    mount: ms.optional(),
    sseOpen: ms.optional(),
    hello: ms.optional(),
    sse: sse.optional(),
    bots: botsRequest.optional(),
    taskSwitch: request.optional(),
    cache: cache.optional(),
    server: server.optional(),
    chatPaint: ms.optional(),
    jsCached: z.boolean().optional(),
    cssCached: z.boolean().optional(),
    navigationType: z.enum(["navigate", "reload", "back_forward", "prerender"]).optional(),
    displayMode: z.enum(["standalone", "browser"]),
    visibility: z.string().max(16),
    build: z.string().max(128).optional(),
    serverStart: z.string().max(32).optional(),
    userAgent: z.string().max(512),
  })
  .strict();

type Received = { status: 200 } | { status: 400 | 413; error: string };
type OpenTimings = z.infer<typeof server>;

// A page's first bots and stream requests land before its record does.
const opens = new Map<string, OpenTimings>();

function noteOpen(id: string, timings: OpenTimings) {
  const merged = { ...opens.get(id), ...timings };
  opens.delete(id);
  opens.set(id, merged);
  if (opens.size > OPEN_IDS_KEPT) opens.delete(opens.keys().next().value!);
}

function openId(value: unknown): string | undefined {
  return typeof value === "string" && OPEN_ID.test(value) ? value : undefined;
}

export function traceOpenBots(req: Pick<IncomingMessage, "headers">, res: { once: (event: "finish", listener: () => void) => unknown }) {
  const id = openId(req.headers[COLD_OPEN_HEADER]);
  if (!id) return;
  const arrived = performance.now();
  res.once("finish", () => noteOpen(id, { botsMs: Math.round(performance.now() - arrived) }));
}

export function traceOpenSse(url: URL, sseClients: number) {
  const id = openId(url.searchParams.get(COLD_OPEN_QUERY));
  if (id) noteOpen(id, { sseClients });
}

async function readCapped(body: AsyncIterable<Buffer>): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep draining past the cap so the 413 still reaches the phone.
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes <= COLD_OPEN_MAX_BYTES) chunks.push(chunk);
  }
  return bytes > COLD_OPEN_MAX_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

export async function receiveColdOpen(req: AsyncIterable<Buffer>, dataDir: string, now = Date.now()): Promise<Received> {
  const text = await readCapped(req);
  if (text === null) return { status: 413, error: "body too large" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, error: "invalid JSON body" };
  }
  const parsed = coldOpenRecordSchema.safeParse(body);
  if (!parsed.success) return { status: 400, error: "invalid cold-open record" };
  if (parsed.data.desktop && parsed.data.label === "open" && parsed.data.chatPaint !== undefined) {
    startupTiming.paint({ firstResponse: parsed.data.nav?.responseStart, chatPaint: parsed.data.chatPaint });
  }
  const path = join(dataDir, COLD_OPEN_FILE);
  mkdirSync(join(dataDir, "diag"), { recursive: true });
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    // First record.
  }
  const { openId: id, ...record } = parsed.data;
  const joined = id ? opens.get(id) : undefined;
  if (id) opens.delete(id);
  const timings = { ...joined, uptimeS: Math.round(process.uptime()) };
  lines.push(JSON.stringify({ receivedAt: new Date(now).toISOString(), ...record, server: timings, serverStart: SERVER_START }));
  writeFileAtomic(path, `${lines.slice(-COLD_OPEN_KEEP).join("\n")}\n`);
  return { status: 200 };
}
