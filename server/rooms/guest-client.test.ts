import { mkdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { listenLocal } from "../phone-relay/testing/net.ts";
import { TestCa } from "../phone-relay/testing/pki.ts";
import { GuestClient, roomCodeHost, type GuestClientDeps } from "./guest-client.ts";
import * as joinedFiles from "./joined-files.ts";
import { addJoinedEntries, closeJoinedDb, joinedKey, joinedRoom, saveJoined, setJoinedState, type JoinedEntry } from "./joined.ts";
import { joinedRoute } from "./joined-routes.ts";

const BASE = "wink.test";
const HOST = `abcdefghijklmnop.${BASE}`;
const SECRET = `wki_${"s".repeat(43)}`;
const KEY = `wkg_${"k".repeat(43)}`;
const CODE = `wkr1:${HOST}:inv1.${SECRET}`;
const PC = "pc-mina-0123456789abcdef";
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

const guest = (deps: Partial<GuestClientDeps> = {}) => (client = new GuestClient({ bases: () => [BASE], joiner: () => ({ name: "Mina Park", device: PC }), https, ...deps }));

const until = async (test: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("room codes", () => {
  it("returns all unread teammate lines and the last entry in list and detail", () => {
    saveJoined("r1", HOST, STATE.me, KEY);
    const lines: JoinedEntry[] = Array.from({ length: 203 }, (_, index) => ({
      seq: index + 1, id: `e${index}`, at: index + 1, text: `line ${index}`,
      author: { kind: "host", id: "host", name: "Edward" },
    }));
    lines.push({ seq: 204, id: "mine", at: 204, text: "Thanks", author: { kind: "person", ...STATE.me } });
    addJoinedEntries("r1", lines, 204);
    const c = guest();
    expect(c.rooms()[0]).toMatchObject({ unread: 203, lastEntry: lines.at(-1) });
    expect(c.room("r1")).toMatchObject({ unread: 203, lastEntry: lines.at(-1) });
    expect(c.room("r1")?.entries).toHaveLength(200);
  });

  it("clears only observed entries through the local read route and broadcasts", async () => {
    saveJoined("r1", HOST, STATE.me, KEY);
    const line = (seq: number): JoinedEntry => ({ seq, id: `e${seq}`, at: seq, text: "Hi", author: { kind: "host", id: "host", name: "Edward" } });
    addJoinedEntries("r1", [line(1), line(2), line(3)], 3);
    const changed = vi.fn();
    const c = guest({ onChange: changed });
    vi.spyOn(c, "start").mockImplementation(() => {});
    const read = (seq: unknown) => joinedRoute("POST", "/api/joined/rooms/r1/read", c, async () => ({ seq }));
    expect((await read(2))?.status).toBe(200);
    expect(c.room("r1")).toMatchObject({ unread: 1 });
    expect(changed).toHaveBeenCalledWith("r1");
    await read(1);
    expect(c.room("r1")).toMatchObject({ unread: 1 });
    await read(3);
    closeJoinedDb();
    expect(guest().rooms()[0]).toMatchObject({ unread: 0 });
    expect((await read("3"))?.status).toBe(400);
    expect((await read(0))?.status).toBe(400);
    expect((await read(999))?.status).toBe(400);
    expect((await joinedRoute("POST", "/api/joined/rooms/missing/read", c, async () => ({ seq: 0 })))?.status).toBe(404);
  });

  it("keeps delayed teammate lines unread when an own-send reply leads the stream", async () => {
    saveJoined("r1", HOST, STATE.me, KEY);
    const line = (seq: number): JoinedEntry => ({ seq, id: `e${seq}`, at: seq, text: "Hi", author: { kind: "host", id: "host", name: "Edward" } });
    addJoinedEntries("r1", [line(1)], 1);
    addJoinedEntries("r1", [{ ...line(3), author: { kind: "person", ...STATE.me } }]);
    const c = guest();
    vi.spyOn(c, "start").mockImplementation(() => {});
    const read = () => joinedRoute("POST", "/api/joined/rooms/r1/read", c, async () => ({ seq: 3 }));
    expect((await read())?.status).toBe(200);
    expect(c.room("r1")?.unread).toBe(0);
    addJoinedEntries("r1", [line(2)], 2);
    closeJoinedDb();
    expect(c.room("r1")?.unread).toBe(1);
    await read();
    expect(c.room("r1")?.unread).toBe(0);
    addJoinedEntries("r1", [line(3)], 3);
    expect(c.room("r1")?.unread).toBe(0);
  });

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
  it("refuses an ordinary join while local removal awaits its files", async () => {
    route = (req, res) => req.url?.endsWith("/leave") ? reply(res, 200, {}) : quietDoor(req, res);
    const c = guest();
    c.start();
    expect((await c.join(CODE)).ok).toBe(true);
    await until(() => c.rooms()[0]?.link === "live");
    expect((await c.leave("r1")).ok).toBe(true);
    let release!: () => void;
    const files = vi.spyOn(joinedFiles, "removeJoinedFiles").mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const removing = c.remove("r1");
    let result;
    try {
      result = await c.join(CODE);
      if (result.ok) await until(() => c.rooms()[0]?.link === "live");
    } finally {
      release();
      await removing;
      files.mockRestore();
    }
    expect(result).toEqual({ ok: false, status: 409, error: "room is busy" });
    expect(joinedRoom("r1")).toBeNull();
    expect((await c.join(CODE)).ok).toBe(true);
    await until(() => c.rooms()[0]?.link === "live");
  });

  it("refuses local removal while an ordinary join awaits the door", async () => {
    route = (req, res) => req.url?.endsWith("/leave") ? reply(res, 200, {}) : quietDoor(req, res);
    const c = guest();
    c.start();
    expect((await c.join(CODE)).ok).toBe(true);
    await until(() => c.rooms()[0]?.link === "live");
    expect((await c.leave("r1")).ok).toBe(true);
    let release: (() => void) | undefined;
    route = (req, res) => {
      if (req.url === "/room/v1/join") release = () => quietDoor(req, res);
      else quietDoor(req, res);
    };
    const joining = c.join(CODE);
    await until(() => Boolean(release));
    let result;
    try {
      result = await c.remove("r1");
    } finally {
      release!();
      await joining;
      await until(() => c.rooms()[0]?.link === "live");
    }
    expect(result).toEqual({ ok: false, status: 409, error: "room is busy" });
    await until(() => c.rooms()[0]?.link === "live");
  });

  it("is one call with the pasted code: the door gets the code and this PC's own name, nothing typed", async () => {
    route = quietDoor;
    const result = await guest().join(`  ${CODE}\n`);
    expect(result).toMatchObject({ ok: true, value: { roomId: "r1", status: "joined", me: { id: "p1", name: "Mina" } } });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/room/v1/join", headers: { host: HOST, origin: `https://${HOST}` } });
    expect(JSON.parse(seen[0]!.body)).toEqual({ code: CODE, name: "Mina Park", device: PC });
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
  it.each([false, true])("identifies this PC when resuming an existing membership with cached state %s", async (cached) => {
    route = quietDoor;
    saveJoined("r1", HOST, STATE.me, KEY);
    if (cached) setJoinedState("r1", STATE);
    closeJoinedDb();
    guest().start();
    await until(() => seen.some((row) => row.url.includes("/stream")));
    expect(seen.some((row) => row.url === "/room/v1/join")).toBe(false);
    expect(seen.filter((row) => row.url.endsWith("/snapshot"))).toHaveLength(cached ? 0 : 1);
    for (const row of seen) expect(row.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "x-wink-device": PC });
  });

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

  it("keeps a character split across stream chunks whole", async () => {
    const frame = Buffer.from(`data: ${JSON.stringify({ kind: "entry", entry: { seq: 1, id: "e1", at: 1, author: { kind: "host", id: "host", name: "Edward" }, text: "안녕 👋" } })}\n\n`);
    const cut = frame.indexOf(Buffer.from("안")) + 1;
    route = (req, res) => {
      if (!req.url?.includes("/stream")) return quietDoor(req, res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame.subarray(0, cut));
      setTimeout(() => res.write(frame.subarray(cut)), 100);
    };
    const c = guest();
    await c.join(CODE);
    await until(() => (c.room("r1")?.entries.length ?? 0) > 0);
    expect(c.room("r1")?.entries[0]?.text).toBe("안녕 👋");
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

describe("races and floods", () => {
  const KEY2 = `wkg_${"m".repeat(43)}`;
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const entry = (seq: number) => ({ seq, id: `e${seq}`, at: seq, author: { kind: "host", id: "host", name: "Edward" }, text: `line ${seq}` });
  const urls = (part: string) => seen.filter((row) => row.url.includes(part)).map((row) => row.url);

  it("a failed snapshot after reset is retried before the stream resumes, whatever frames came meanwhile", async () => {
    let snapshots = 0;
    let streams = 0;
    route = (req, res) => {
      if (req.url?.endsWith("/snapshot")) return ++snapshots === 2 ? reply(res, 503, { error: "phone access is off" }) : quietDoor(req, res);
      if (req.url?.includes("/stream") && ++streams === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ kind: "reset" }) + frame({ kind: "entry", entry: entry(5) }) + frame({ kind: "state", state: { ...STATE, version: 2 } }));
        return;
      }
      quietDoor(req, res);
    };
    await guest({ timing: { retryMs: 20 } }).join(CODE);
    await until(() => urls("/stream").length >= 2);
    expect(snapshots).toBe(3);
    expect(urls("/stream")[1]).toBe("/room/v1/rooms/r1/stream?after=0");
  });

  it("a late 401 or leave from before a rejoin leaves the new key alone", async () => {
    let joins = 0;
    route = (req, res) => {
      if (req.url === "/room/v1/join") return reply(res, 200, { roomId: "r1", person: { id: "p1", name: "Mina" }, key: ++joins === 1 ? KEY : KEY2 });
      if (req.url?.endsWith("/send")) return void setTimeout(() => reply(res, 401, { error: "unauthorized" }), 200);
      if (req.url?.endsWith("/leave")) return void setTimeout(() => reply(res, 200, { ok: true }), 200);
      quietDoor(req, res);
    };
    const c = guest();
    await c.join(CODE);
    await until(() => urls("/stream").length >= 1);
    const late = [c.send("r1", "old"), c.leave("r1")];
    await until(() => urls("/send").length >= 1 && urls("/leave").length >= 1);
    await c.join(CODE);
    await Promise.all(late);
    expect(joinedRoom("r1")).toMatchObject({ status: "joined" });
    expect(joinedKey("r1")?.key).toBe(KEY2);
  });

  it("a flood of resets costs one snapshot at a time", async () => {
    let streams = 0;
    route = (req, res) => {
      if (req.url?.endsWith("/snapshot")) return void setTimeout(() => quietDoor(req, res), 200);
      if (req.url?.includes("/stream") && ++streams === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ kind: "reset" }).repeat(50));
        return;
      }
      quietDoor(req, res);
    };
    await guest().join(CODE);
    await until(() => urls("/stream").length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(urls("/snapshot")).toHaveLength(2);
  });

  it("refuses sends past a small queue instead of waiting on a silent host", async () => {
    const held: ServerResponse[] = [];
    route = (req, res) => (req.url?.endsWith("/send") ? void held.push(res) : quietDoor(req, res));
    const c = guest();
    await c.join(CODE);
    const queued = Array.from({ length: 20 }, (_, i) => c.send("r1", `m${i}`));
    const extra = await Promise.race([c.send("r1", "one too many"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
    expect(extra).toEqual({ ok: false, status: 429, error: "too many messages waiting to send" });
    route = (req, res) => (req.url?.endsWith("/send") ? reply(res, 503, { error: "phone access is off" }) : quietDoor(req, res));
    for (const res of held) reply(res, 503, { error: "phone access is off" });
    await until(() => held.every((res) => res.writableEnded));
    expect((await Promise.all(queued)).every((result) => !result.ok && result.status === 503)).toBe(true);
  });

  it("a 401 that lands during a leave reads as left", async () => {
    route = (req, res) => {
      if (req.url?.endsWith("/leave")) return void setTimeout(() => reply(res, 200, { ok: true }), 200);
      if (req.url?.endsWith("/send")) return reply(res, 401, { error: "unauthorized" });
      quietDoor(req, res);
    };
    const c = guest();
    await c.join(CODE);
    const leaving = c.leave("r1");
    await until(() => urls("/leave").length >= 1);
    await c.send("r1", "too late");
    await leaving;
    expect(joinedRoom("r1")).toMatchObject({ status: "left" });
  });
});

describe("room alerts on a teammate", () => {
  const entry = (seq: number, author: JoinedEntry["author"], text: string) => `data: ${JSON.stringify({ kind: "entry", entry: { seq, id: `e${seq}`, at: seq, author, text } })}\n\n`;
  const edward = { kind: "host" as const, id: "host", name: "Edward" };
  const mina = { kind: "person" as const, ...STATE.me };
  const ping = (text: string) => [{ chat: "joined:r1", threadId: "joined:r1", room: "Team", name: "Edward", text }];
  const stream = (frames: Array<[number, string]>) => (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.includes("/stream")) return quietDoor(req, res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ kind: "state", state: STATE })}\n\n`);
    for (const [ms, frame] of frames) setTimeout(() => res.write(frame), ms);
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("pings someone else's line after the wait and never an own line", async () => {
    route = stream([[0, entry(1, mina, "on my way")], [0, entry(2, edward, "hi")]]);
    const alert = vi.fn();
    const c = guest({ alert, timing: { alertMs: 50 } });
    await c.join(CODE);
    await until(() => c.room("r1")?.entries.length === 2);
    await sleep(200);
    expect(alert.mock.calls).toEqual([ping("hi")]);
  });

  it("stays quiet when the room is read on screen within the wait", async () => {
    route = stream([[0, entry(1, edward, "first")], [400, entry(2, edward, "second")]]);
    const alert = vi.fn();
    const c = guest({ alert, timing: { alertMs: 150 } });
    await c.join(CODE);
    await until(() => c.room("r1")?.entries.length === 1);
    expect((await joinedRoute("POST", "/api/joined/rooms/r1/read", c, async () => ({ seq: 1 })))?.status).toBe(200);
    await until(() => c.room("r1")?.entries.length === 2);
    await sleep(300);
    expect(alert.mock.calls).toEqual([ping("second")]);
  });

  it("pings a reconnect replay once with its latest line, then live lines again", async () => {
    const replay = Array.from({ length: 60 }, (_, index): [number, string] => [0, entry(index + 1, edward, `line ${index + 1}`)]);
    route = stream([...replay, [300, entry(61, edward, "live")]]);
    const alert = vi.fn();
    const c = guest({ alert, timing: { alertMs: 100 } });
    await c.join(CODE);
    await until(() => c.room("r1")?.entries.length === 61);
    await sleep(250);
    expect(alert.mock.calls).toEqual([ping("line 60"), ping("live")]);
  });
});
