import { mkdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { createSecureContext } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { listenLocal } from "../phone-relay/testing/net.ts";
import { TestCa } from "../phone-relay/testing/pki.ts";
import { GuestClient, type GuestClientDeps } from "./guest-client.ts";
import { closeJoinedDb, joinedCode } from "./joined.ts";

const BASE = "wink.test";
const LABEL = "abcdefghijklmnop";
const HOST = `${LABEL}.${BASE}`;
const LONG = `wkr1:${HOST}:inv1.wki_${"s".repeat(43)}`;
const KEY = `wkg_${"k".repeat(43)}`;
const STATE = { version: 1, roomName: "Team", instructions: "", host: "Edward", me: { id: "p1", name: "Mina" }, people: [], bots: [] };

let server: Server;
let https: GuestClientDeps["https"];
let seen: Array<{ host: string; url: string; body: string }> = [];
let route: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let client: GuestClient | null = null;

beforeAll(async () => {
  const ca = await TestCa.create();
  const contexts = new Map<string, ReturnType<typeof createSecureContext>>();
  for (const name of [HOST, `relay.${BASE}`]) {
    const { keyPem, certPem } = await ca.issue(name);
    contexts.set(name, createSecureContext({ key: keyPem, cert: certPem }));
  }
  server = createServer({ SNICallback: (name, cb) => cb(null, contexts.get(name)) }, (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({ host: req.headers.host ?? "", url: req.url ?? "", body });
      route(req, res, body);
    });
  });
  https = { ca: ca.certPem, lookup: loopbackLookup, port: await listenLocal(server) };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

afterEach(() => {
  client?.stop();
  client = null;
  seen = [];
  server.closeAllConnections();
  closeJoinedDb();
});

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function door(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/v1/room-codes/ABCDEF") return reply(res, 200, { label: LABEL });
  if (req.url?.startsWith("/v1/room-codes/")) return reply(res, 404, { error: "not-found" });
  if (req.url === "/room/v1/join") return reply(res, 200, { roomId: "r1", person: { id: "p1", name: "Mina" }, key: KEY, code: LONG });
  if (req.url?.includes("/snapshot")) return reply(res, 200, { head: 0, entries: [], state: STATE });
  reply(res, 404, { error: "not found" });
}

const guest = () => (client = new GuestClient({ bases: () => [BASE], joiner: () => ({ name: "Mina", device: "pc-mina-0123456789abcdef" }), https }));

describe("join with a short code", () => {
  it("looks the code up on the relay, joins the door with it and keeps the long code", async () => {
    route = door;
    const result = await guest().join(" abcdef ");
    expect(result.ok).toBe(true);
    expect(seen.slice(0, 2).map(({ host, url }) => [host, url])).toEqual([[`relay.${BASE}`, "/v1/room-codes/ABCDEF"], [HOST, "/room/v1/join"]]);
    expect(JSON.parse(seen[1]!.body).code).toBe("ABCDEF");
    expect(joinedCode("r1")).toBe(LONG);
  });

  it("says a wrong or expired code is wrong, without knocking on any door", async () => {
    route = door;
    expect(await guest().join("GHJKLM")).toEqual({ ok: false, status: 404, error: "no-invite" });
    expect(seen.map((each) => each.url)).toContain("/v1/room-codes/GHJKLM");
    expect(seen.map((each) => each.url)).not.toContain("/room/v1/join");
  });

  it("passes a relay rate limit through", async () => {
    route = (_req, res) => reply(res, 429, { error: "rate-limited" });
    expect(await guest().join("ABCDEF")).toEqual({ ok: false, status: 429, error: "rate-limited" });
  });

  it("is unreachable when the relay is", async () => {
    route = (_req, res) => res.socket?.destroy();
    expect(await guest().join("ABCDEF")).toMatchObject({ ok: false, status: 503 });
  });

  it("refuses a short code without a door's long code back", async () => {
    route = (req, res) => req.url === "/room/v1/join" ? reply(res, 200, { roomId: "r1", person: { id: "p1", name: "Mina" }, key: KEY }) : door(req, res);
    expect(await guest().join("ABCDEF")).toMatchObject({ ok: false, status: 503 });
  });
});
