import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listenLocal } from "./phone-relay/testing/net.ts";
import type { JsonObject } from "./schema.ts";
import { TERMINAL_INPUT_GRANT_PREFIX, terminalInputGrant, terminalReadGrant } from "./terminal-grant.ts";
import { createTerminalLive, type TerminalLiveDeps } from "./terminal-live.ts";

const TOKEN = "bridge-secret";
const BOT_BEARER = "Bearer bot-caller";
const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = { sessionId: "s1", generation: 2, output: "hello", seq: 3, cols: 80, rows: 24, modes: {}, resetModes: "", exitCode: null };

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return `http://127.0.0.1:${await listenLocal(server)}`;
}

/** The Electron bridge's stream, input and resize routes, with its grants. */
async function fakeBridge() {
  const viewers = new Set<ServerResponse>();
  const posted: Array<{ route: string; body: JsonObject }> = [];
  const url = await listen(async (req, res) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = parsed.pathname.match(/^\/v1\/bots\/([\w-]+)\/terminal\/(stream|input|resize)$/)!;
    const reply = (status: number, value: JsonObject) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (m[2] === "stream") {
      if (req.headers.authorization !== `Bearer ${terminalReadGrant(TOKEN, m[1]!)}`) return reply(401, { error: "Unauthorized" });
      if (parsed.searchParams.get("sessionId") === "gone") return reply(409, { error: "Unknown terminal" });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify(SNAPSHOT)}\n`);
      viewers.add(res);
      res.once("close", () => viewers.delete(res));
      return;
    }
    if (req.headers.authorization !== `Bearer ${terminalInputGrant(TOKEN, m[1]!)}`) return reply(403, { error: "Forbidden" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input: JsonObject = JSON.parse(raw);
    if (input.sessionId === "stale") return reply(409, { error: "Terminal session is stale; take a fresh snapshot" });
    posted.push({ route: m[2]!, body: input });
    reply(200, m[2] === "input" ? { sent: true } : { resized: true });
  });
  return {
    access: { url, token: TOKEN },
    viewers,
    posted,
    emit: (...frames: JsonObject[]) => { for (const viewer of viewers) for (const frame of frames) viewer.write(`${JSON.stringify(frame)}\n`); },
  };
}

async function setup(options: Partial<TerminalLiveDeps> = {}) {
  const bridge = await fakeBridge();
  const live = createTerminalLive({ access: () => bridge.access, botCaller: (header) => header === BOT_BEARER, ...options });
  const base = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = url.pathname.match(/^\/api\/bots\/([\w-]+)\/terminal\/(live|input|resize|lease)$/)!;
    void live.handle(req, res, m[1]!, m[2]!, url);
  });
  const post = (route: string, value: JsonObject, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/bots/bot-1/terminal/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  return { bridge, base, post };
}

type Frame = { id?: string; data?: JsonObject; comment?: string };

/** An SSE reader that keeps ids and comments, which EventSource hides. */
async function openStream(url: string, headers: Record<string, string> = {}) {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  const frames: Frame[] = [];
  let ended = false;
  if (res.ok) {
    void (async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for await (const chunk of res.body!) {
          buffered += decoder.decode(chunk, { stream: true });
          let gap: number;
          while ((gap = buffered.indexOf("\n\n")) >= 0) {
            const frame: Frame = {};
            for (const line of buffered.slice(0, gap).split("\n")) {
              if (line.startsWith("id: ")) frame.id = line.slice(4);
              else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
              else if (line.startsWith(": ")) frame.comment = line.slice(2);
            }
            frames.push(frame);
            buffered = buffered.slice(gap + 2);
          }
        }
      } catch {}
      ended = true;
    })();
  }
  return { res, frames, ended: () => ended, close: () => abort.abort(), kinds: () => frames.filter((frame) => frame.data).map((frame) => frame.data!.kind) };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("live terminal stream", () => {
  it("sends the snapshot first, then output in order with the seq as the event id", async () => {
    const { bridge, base } = await setup();
    const stream = await openStream(`${base}/api/bots/bot-1/terminal/live?sessionId=s1`);
    expect(stream.res.headers.get("content-type")).toBe("text/event-stream");
    await vi.waitFor(() => expect(stream.frames).toHaveLength(1));
    expect(stream.frames[0]).toEqual({ id: "3", data: { kind: "snapshot", lease: expect.any(String), ...SNAPSHOT } });
    bridge.emit({ seq: 4, data: "a" });
    await vi.waitFor(() => expect(stream.frames).toHaveLength(2));
    bridge.emit({ seq: 5, data: "b" });
    await vi.waitFor(() => expect(stream.frames).toHaveLength(3));
    bridge.emit({ cols: 100, rows: 30 });
    await vi.waitFor(() => expect(stream.frames).toHaveLength(4));
    expect(stream.frames.slice(1)).toEqual([
      { id: "4", data: { kind: "output", seq: 4, data: "a" } },
      { id: "5", data: { kind: "output", seq: 5, data: "b" } },
      { data: { kind: "resize", cols: 100, rows: 30 } },
    ]);
    stream.close();
  });

  it("batches output that arrives within 5 ms into one frame", async () => {
    const { bridge, base } = await setup();
    const stream = await openStream(`${base}/api/bots/bot-1/terminal/live`);
    await vi.waitFor(() => expect(stream.frames).toHaveLength(1));
    bridge.emit({ seq: 4, data: "한" }, { seq: 5, data: "글" }, { seq: 6, data: "\r\n" });
    await vi.waitFor(() => expect(stream.frames).toHaveLength(2));
    await delay(30);
    expect(stream.frames[1]).toEqual({ id: "6", data: { kind: "output", seq: 6, data: "한글\r\n" } });
    expect(stream.frames).toHaveLength(2);
    stream.close();
  });

  it("flushes pending output before an exit and then ends", async () => {
    const { bridge, base } = await setup();
    const stream = await openStream(`${base}/api/bots/bot-1/terminal/live`);
    await vi.waitFor(() => expect(stream.frames).toHaveLength(1));
    bridge.emit({ seq: 4, data: "bye" }, { exitCode: 0 });
    for (const viewer of bridge.viewers) viewer.end();
    await vi.waitFor(() => expect(stream.ended()).toBe(true));
    expect(stream.kinds()).toEqual(["snapshot", "output", "exit"]);
  });

  it("sends a heartbeat comment and ping while the pane is quiet", async () => {
    const { base } = await setup({ heartbeatMs: 20 });
    const stream = await openStream(`${base}/api/bots/bot-1/terminal/live`);
    await vi.waitFor(() => expect(stream.kinds()).toContain("ping"));
    const ping = stream.frames.findIndex((frame) => frame.data?.kind === "ping");
    expect(stream.frames.slice(ping - 1, ping + 1)).toEqual([{ comment: "keepalive" }, { data: { kind: "ping" } }]);
    stream.close();
  });

  it("ends the bridge stream when the tab closes", async () => {
    const { bridge, base } = await setup();
    const stream = await openStream(`${base}/api/bots/bot-1/terminal/live`);
    await vi.waitFor(() => expect(bridge.viewers.size).toBe(1));
    stream.close();
    await vi.waitFor(() => expect(bridge.viewers.size).toBe(0));
  });

  it("ends the bridge stream when the lease lapses, and a renewed lease keeps it", async () => {
    const { bridge, base, post } = await setup({ leaseMs: 300 });
    const stream = await openStream(`${base}/api/bots/bot-1/terminal/live`);
    await vi.waitFor(() => expect(stream.frames).toHaveLength(1));
    const lease = String(stream.frames[0]!.data!.lease);
    for (let i = 0; i < 3; i += 1) {
      await delay(150);
      expect((await post("lease", { lease })).status).toBe(200);
    }
    expect(bridge.viewers.size).toBe(1);
    await vi.waitFor(() => expect(stream.ended()).toBe(true), { timeout: 2_000 });
    expect(bridge.viewers.size).toBe(0);
    expect((await post("lease", { lease })).status).toBe(404);
  });

  it("refuses another bot's lease", async () => {
    const { base, post } = await setup();
    const stream = await openStream(`${base}/api/bots/bot-2/terminal/live`);
    await vi.waitFor(() => expect(stream.frames).toHaveLength(1));
    expect((await post("lease", { lease: String(stream.frames[0]!.data!.lease) })).status).toBe(404);
    stream.close();
  });

  it("answers an unknown pane and a missing bridge without streaming", async () => {
    const { base } = await setup();
    const gone = await openStream(`${base}/api/bots/bot-1/terminal/live?sessionId=gone`);
    expect(gone.res.status).toBe(404);
    const live = createTerminalLive({ access: () => null, botCaller: () => false });
    const off = await listen((req, res) => void live.handle(req, res, "bot-1", "live", new URL(req.url ?? "/", "http://localhost")));
    expect((await fetch(off)).status).toBe(503);
  });
});

describe("live terminal keys", () => {
  it("forwards raw keys, Ctrl+C included, and a resize with the input grant", async () => {
    const { bridge, post } = await setup();
    const input = await post("input", { sessionId: "s1", generation: 2, data: "\x03ls\r" });
    expect(input.status).toBe(200);
    expect(await input.json()).toEqual({ sent: true });
    expect((await post("resize", { sessionId: "s1", generation: 2, cols: 120, rows: 40 })).status).toBe(200);
    expect(bridge.posted).toEqual([
      { route: "input", body: { sessionId: "s1", generation: 2, data: "\x03ls\r" } },
      { route: "resize", body: { sessionId: "s1", generation: 2, cols: 120, rows: 40 } },
    ]);
  });

  it("passes a stale session back and refuses a bad body", async () => {
    const { bridge, post } = await setup();
    expect((await post("input", { sessionId: "stale", generation: 1, data: "x" })).status).toBe(409);
    expect((await post("input", { sessionId: "s1", data: "x" })).status).toBe(400);
    expect((await post("input", { sessionId: "s1", generation: 2, data: "x".repeat(64 * 1024 + 1) })).status).toBe(400);
    expect((await post("resize", { sessionId: "s1", generation: 2, cols: "wide", rows: 40 })).status).toBe(400);
    expect(bridge.posted).toEqual([]);
  });

  it("refuses a bot's bearer on every live route", async () => {
    const { bridge, base, post } = await setup();
    const stream = await openStream(`${base}/api/bots/bot-1/terminal/live`, { authorization: BOT_BEARER });
    expect(stream.res.status).toBe(403);
    for (const route of ["input", "resize", "lease"]) {
      expect((await post(route, { sessionId: "s1", generation: 2, data: "x", cols: 80, rows: 24 }, { authorization: BOT_BEARER })).status).toBe(403);
    }
    expect(bridge.viewers.size).toBe(0);
    expect(bridge.posted).toEqual([]);
  });

  it("takes each route by its own method only", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/api/bots/bot-1/terminal/live`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/bots/bot-1/terminal/input`)).status).toBe(405);
  });
});

describe("live terminal wiring", () => {
  it("uses the Electron bridge's input grant", () => {
    expect(readFileSync(join(here, "..", "electron", "terminal-bridge.mjs"), "utf8")).toContain(`INPUT_GRANT_PREFIX = "${TERMINAL_INPUT_GRANT_PREFIX}"`);
  });

  it("routes the live paths behind the /api gates, knows bot callers and tells clients", () => {
    const server = readFileSync(join(here, "index.ts"), "utf8");
    const gate = server.indexOf('return json(res, 401, { error: "unauthorized" });');
    const route = server.indexOf("terminal\\/(live|input|resize|lease)$/");
    expect(gate).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(gate);
    expect(server).toContain("botCaller: (header) => Boolean(commsCallers.resolve(header))");
    expect(server).toMatch(/terminalHost: Boolean\(terminalBridgeAccess\),\s+terminalLive: true,/);
  });
});
