import { mkdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { listenLocal } from "../phone-relay/testing/net.ts";
import { TestCa } from "../phone-relay/testing/pki.ts";
import { GuestClient, roomCodeHost, type GuestClientDeps } from "./guest-client.ts";
import { closeJoinedDb, joinedKey, joinedRoom } from "./joined.ts";

const BASE = "wink.test";
const HOST = `abcdefghijklmnop.${BASE}`;
const SECRET = `wki_${"s".repeat(43)}`;
const KEY = `wkg_${"k".repeat(43)}`;
const CODE = `wkr1:${HOST}:inv1.${SECRET}`;
const STATE = { version: 1, roomName: "Team", instructions: "", host: "Edward", me: { id: "p1", name: "Mina" }, people: [{ id: "p1", name: "Mina" }], bots: [], myAsks: [] };

let server: Server;
let https: GuestClientDeps["https"];
let seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
let route: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let client: GuestClient | null = null;

beforeAll(async () => {
  const ca = await TestCa.create();
  const { keyPem, certPem } = await ca.issue(HOST);
  server = createServer({ key: keyPem, cert: certPem }, (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
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

/** Join, snapshot and a stream that sends state once and then stays silent. */
function quietDoor(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/room/v1/join") return reply(res, 200, { roomId: "r1", person: { id: "p1", name: "Mina" }, key: KEY });
  if (req.url?.endsWith("/snapshot")) return reply(res, 200, { head: 0, entries: [], state: STATE });
  if (req.url?.includes("/stream")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ kind: "state", state: STATE })}\n\n`);
    return;
  }
  reply(res, 404, { error: "not found" });
}

const guest = (deps: Partial<GuestClientDeps> = {}) => (client = new GuestClient({ bases: () => [BASE], https, ...deps }));

const until = async (test: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("room codes", () => {
  it("takes only a strict code whose host is a label under an allowed base", () => {
    expect(roomCodeHost(CODE, [BASE])).toBe(HOST);
    expect(roomCodeHost(CODE, [null, "other.test", BASE])).toBe(HOST);
    expect(roomCodeHost(CODE.toUpperCase(), [BASE])).toBeNull();
    const refused = [
      `wkr1:${BASE}:inv1.${SECRET}`,
      `wkr1:relay.${BASE}:inv1.${SECRET}`,
      `wkr1:x.${HOST}:inv1.${SECRET}`,
      `wkr1:abcdefghijklmnopwink.test:inv1.${SECRET}`,
      `wkr1:abcdefghijklmnop.evilwink.test:inv1.${SECRET}`,
      `wkr1:abcdefghijklmnop.wink.test.evil.example:inv1.${SECRET}`,
      `wkr1:abcdefghijklmnop.wink.test.:inv1.${SECRET}`,
      `wkr1:abcdefghijklmno1.wink.test:inv1.${SECRET}`,
      `wkr1:${HOST}:443:inv1.${SECRET}`,
      `wkr1:${HOST}:inv1.${SECRET}x`,
      `wkr1:${HOST}:inv1.wki_short`,
      `wkr1:${HOST}:in.v1.${SECRET}`,
      `wkr2:${HOST}:inv1.${SECRET}`,
      ` ${CODE}`,
    ];
    for (const code of refused) expect([code, roomCodeHost(code, [BASE])]).toEqual([code, null]);
    expect(roomCodeHost(CODE, [])).toBeNull();
    expect(roomCodeHost(CODE, ["evil.example"])).toBeNull();
  });

  it("refuses a bad code without any request", async () => {
    route = quietDoor;
    const result = await guest({ bases: () => ["evil.example"] }).join(CODE);
    expect(result).toEqual({ ok: false, status: 400, error: "bad-code" });
    expect(seen).toEqual([]);
  });
});

describe("join", () => {
  it("is one call with the pasted code: the door gets the code and nothing typed", async () => {
    route = quietDoor;
    const result = await guest().join(`  ${CODE}\n`);
    expect(result).toMatchObject({ ok: true, value: { roomId: "r1", status: "joined", me: { id: "p1", name: "Mina" } } });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/room/v1/join", headers: { host: HOST, origin: `https://${HOST}` } });
    expect(JSON.parse(seen[0]!.body)).toEqual({ code: CODE });
    expect(seen[0]!.headers.authorization).toBeUndefined();
    await until(() => seen.some((row) => row.url.includes("/stream")));
    expect(seen.map((row) => row.url)).toEqual(["/room/v1/join", "/room/v1/rooms/r1/snapshot", "/room/v1/rooms/r1/stream?after=0"]);
    expect(seen[1]!.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(seen.every((row) => row.headers.cookie === undefined)).toBe(true);
  });

  it("follows no redirect and stores nothing on a refusal", async () => {
    route = (_req, res) => {
      res.writeHead(307, { location: `https://${HOST}/room/v1/join2` });
      res.end();
    };
    expect(await guest().join(CODE)).toEqual({ ok: false, status: 503, error: "unavailable" });
    expect(seen.map((row) => row.url)).toEqual(["/room/v1/join"]);
    route = (_req, res) => reply(res, 401, { error: "wrong-secret" });
    expect(await guest().join(CODE)).toEqual({ ok: false, status: 401, error: "wrong-secret" });
    expect(joinedRoom("r1")).toBeNull();
  });

  it("ignores a cookie the host sets", async () => {
    route = (req, res) => {
      if (req.url === "/room/v1/join") res.setHeader("set-cookie", "__Host-wink_phone=owner; Secure; Path=/");
      quietDoor(req, res);
    };
    await guest().join(CODE);
    await until(() => seen.some((row) => row.url.includes("/stream")));
    expect(seen.every((row) => row.headers.cookie === undefined)).toBe(true);
  });
});

describe("sync", () => {
  it("reconnects from the newest seq when the heartbeat stops", async () => {
    route = quietDoor;
    const c = guest({ timing: { silenceMs: 200, retryMs: 20 } });
    await c.join(CODE);
    await until(() => seen.filter((row) => row.url.includes("/stream")).length >= 2);
    expect(seen.filter((row) => row.url.endsWith("/snapshot"))).toHaveLength(1);
  });

  it("stays live on heartbeats alone", async () => {
    route = (req, res) => {
      quietDoor(req, res);
      if (req.url?.includes("/stream")) {
        const ping = setInterval(() => res.write(": ping\n\n"), 50);
        res.once("close", () => clearInterval(ping));
      }
    };
    const c = guest({ timing: { silenceMs: 300, retryMs: 20 } });
    await c.join(CODE);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(seen.filter((row) => row.url.includes("/stream"))).toHaveLength(1);
    expect(c.rooms()[0]).toMatchObject({ link: "live" });
  });

  it("marks the room removed when the key is refused", async () => {
    route = (req, res) => (req.url === "/room/v1/join" ? quietDoor(req, res) : reply(res, 401, { error: "unauthorized" }));
    const changed = vi.fn();
    await guest({ onChange: changed }).join(CODE);
    await until(() => joinedRoom("r1")?.status === "removed");
    expect(joinedKey("r1")).toBeNull();
    expect(await client!.send("r1", "hi")).toEqual({ ok: false, status: 409, error: "this room is read-only" });
    expect(JSON.stringify(changed.mock.calls)).not.toContain(KEY);
  });

  it("goes offline and backs off while the host is unreachable", async () => {
    route = (req, res) => (req.url === "/room/v1/join" ? quietDoor(req, res) : reply(res, 503, { error: "phone access is off" }));
    const c = guest({ timing: { retryMs: 100, maxRetryMs: 100 } });
    await c.join(CODE);
    await until(() => seen.length >= 3);
    expect(c.rooms()[0]).toMatchObject({ status: "joined", link: "offline" });
    expect(joinedKey("r1")).not.toBeNull();
  });
});
