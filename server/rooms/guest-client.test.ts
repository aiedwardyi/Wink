import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { listenLocal } from "../phone-relay/testing/net.ts";
import { TestCa } from "../phone-relay/testing/pki.ts";
import { GuestClient, roomCodeHost, uploadDeadline, type GuestClientDeps } from "./guest-client.ts";
import * as joinedFiles from "./joined-files.ts";
import { addJoinedEntries, closeJoinedDb, joinedEntries, joinedKey, joinedRoom, saveJoined, setJoinedSentName, setJoinedState, type JoinedEntry } from "./joined.ts";
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
  if (req.url?.includes("/snapshot")) return reply(res, 200, { head: 0, entries: [], state: STATE });
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

  it("hands the owner's Stop to this PC's own room turns", async () => {
    const stop = vi.fn(async () => {});
    const c = guest();
    vi.spyOn(c, "start").mockImplementation(() => {});
    expect(await joinedRoute("POST", "/api/joined/rooms/r1/stop", c, async () => ({}), undefined, undefined, stop)).toEqual({ status: 200, body: { ok: true } });
    expect(stop).toHaveBeenCalledWith("r1");
    expect((await joinedRoute("GET", "/api/joined/rooms/r1/stop", c, async () => ({}), undefined, undefined, stop))?.status).toBe(404);
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
    expect(seen.map((row) => row.url)).toEqual(["/room/v1/join", "/room/v1/rooms/r1/snapshot?with=bots", "/room/v1/rooms/r1/stream?after=0&with=bots&deleted=0"]);
    expect(seen[1]!.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(seen.every((row) => row.headers.cookie === undefined)).toBe(true);
  });

  it("never joins this PC's own room: it names the hosted group and sends nothing", async () => {
    route = quietDoor;
    const own = vi.fn((code: string) => (code.trim() === CODE ? "g-host" : null));
    expect(await guest({ ownRoom: own }).join(`  ${CODE}
`)).toEqual({ ok: false, status: 409, error: "own-room", groupId: "g-host" });
    expect(await joinedRoute("POST", "/api/joined/join", client!, async () => ({ code: CODE }))).toEqual({ status: 409, body: { error: "own-room", groupId: "g-host" } });
    expect(seen).toEqual([]);
    expect(joinedRoom("r1")).toBeNull();
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
    expect(seen.filter((row) => row.url.includes("/snapshot"))).toHaveLength(cached ? 0 : 1);
    for (const row of seen) expect(row.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "x-wink-device": PC, "x-orbit-room-files": "1", "x-orbit-room-media": "1" });
  });

  it("keeps the live stream when started after joining", async () => {
    route = quietDoor;
    const c = guest();
    await c.join(CODE);
    await until(() => c.room("r1")?.link === "live");
    c.start();
    expect(c.room("r1")?.link).toBe("live");
    await c.nameChanged();
    expect(seen.filter((row) => row.url.includes("/stream"))).toHaveLength(1);
  });

  it("reconnects from the newest seq when the heartbeat stops", async () => {
    route = quietDoor;
    const c = guest({ timing: { silenceMs: 200, retryMs: 20 } });
    await c.join(CODE);
    await until(() => seen.filter((row) => row.url.includes("/stream")).length >= 2);
    expect(seen.filter((row) => row.url.includes("/snapshot"))).toHaveLength(1);
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
      if (req.url?.includes("/snapshot")) return ++snapshots === 2 ? reply(res, 503, { error: "phone access is off" }) : quietDoor(req, res);
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
    expect(urls("/stream")[1]).toBe("/room/v1/rooms/r1/stream?after=0&with=bots&deleted=0");
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
      if (req.url?.includes("/snapshot")) return void setTimeout(() => quietDoor(req, res), 200);
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

describe("deleted files", () => {
  it("marks a file the host deleted while this PC was away and drops its local copy", async () => {
    const file = { id: "f".repeat(24), name: "notes.txt", type: "text/plain", bytes: 5, sha256: "0".repeat(64) };
    saveJoined("r1", HOST, STATE.me, KEY);
    setJoinedState("r1", STATE);
    addJoinedEntries("r1", [{ seq: 1, id: "e1", at: 1, author: { kind: "host", id: "host", name: "Edward" }, text: "", files: [file] }], 1);
    const cached = join(DATA_DIR, "joined-files", "r1", file.id);
    mkdirSync(join(DATA_DIR, "joined-files", "r1"), { recursive: true });
    writeFileSync(cached, "hello");
    route = (req, res) => {
      quietDoor(req, res);
      if (req.url?.includes("/stream")) res.write(`data: ${JSON.stringify({ kind: "deleted", ids: [file.id] })}

`);
    };
    guest().start();
    await until(() => !existsSync(cached));
    expect(joinedEntries("r1", 5)[0]!.files).toEqual([{ ...file, deleted: true }]);
  });

  it("asks only for deletions past the count it holds, and keeps the host's new count", async () => {
    saveJoined("r1", HOST, STATE.me, KEY);
    setJoinedState("r1", STATE);
    const asked: string[] = [];
    let count: number | undefined = 3;
    route = (req, res) => {
      quietDoor(req, res);
      if (!req.url?.includes("/stream")) return;
      asked.push(new URL(req.url, "https://x").searchParams.get("deleted") ?? "");
      res.write(`data: ${JSON.stringify({ kind: "deleted", ids: ["a".repeat(24)], ...(count === undefined ? {} : { count }) })}\n\n`);
      setTimeout(() => res.destroy(), 50);
    };
    guest({ timing: { retryMs: 10 } }).start();
    await until(() => asked.length >= 2);
    count = undefined;
    await until(() => asked.length >= 4);
    expect(asked.slice(0, 4)).toEqual(["0", "3", "3", "3"]);
  });

  it("holds the count while a deleted file's copy can't be dropped, so the next stream sends it again", async () => {
    saveJoined("r1", HOST, STATE.me, KEY);
    setJoinedState("r1", STATE);
    // Not the last test's id: its stopped client can still be mid-rm on that path, and fs.rm takes a dir made meanwhile
    const copy = join(DATA_DIR, "joined-files", "r1", "b".repeat(24));
    mkdirSync(join(copy, "held"), { recursive: true });
    const asked: string[] = [];
    route = (req, res) => {
      quietDoor(req, res);
      if (!req.url?.includes("/stream")) return;
      asked.push(new URL(req.url, "https://x").searchParams.get("deleted") ?? "");
      res.write(`data: ${JSON.stringify({ kind: "deleted", ids: ["b".repeat(24)], count: 3 })}\n\n`);
      setTimeout(() => res.destroy(), 50);
    };
    guest({ timing: { retryMs: 10 } }).start();
    await until(() => asked.length >= 2);
    expect(asked.slice(0, 2)).toEqual(["0", "0"]);
    rmSync(copy, { recursive: true });
    await until(() => asked.includes("3"));
    expect(existsSync(copy)).toBe(false);
  });
});

describe("teammate media files", () => {
  it("takes a video or audio file back from an upload", async () => {
    saveJoined("r1", HOST, STATE.me, KEY);
    setJoinedState("r1", STATE);
    for (const type of ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "audio/mp4", "audio/mpeg", "audio/wav"]) {
      const file = { id: "f".repeat(24), name: "clip", type, bytes: 5, sha256: "0".repeat(64) };
      route = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ file }));
      };
      expect(await guest().upload("r1", Buffer.from("hello"), "clip", "u".repeat(16), "5")).toMatchObject({ ok: true, value: file });
    }
  });
});

describe("upload deadline", () => {
  it("grows with size so a 1 GB file on a 10 Mbps uplink is not cut", () => {
    expect(uploadDeadline("1000")).toBe(10 * 60_000 + 8);
    expect(uploadDeadline(String(1024 ** 3))).toBeGreaterThan((1024 ** 3 * 8) / 10_000);
    expect(uploadDeadline(undefined)).toBe(uploadDeadline(String(1024 ** 3)));
  });
});

describe("own name", () => {
  it("retries a pending name only when that room reconnects", async () => {
    let name = "Mina Park";
    let online = false;
    let stream: ServerResponse | null = null;
    route = (req, res) => {
      if (req.url?.endsWith("/name")) return reply(res, online ? 200 : 503, online ? { name } : { error: "unavailable" });
      if (req.url?.includes("/stream")) stream = res;
      quietDoor(req, res);
    };
    const c = guest({ joiner: () => ({ name, device: PC }), timing: { retryMs: 20 } });
    await c.join(CODE);
    await until(() => c.room("r1")?.link === "live");
    name = "민아";
    await c.nameChanged();
    expect(seen.filter((row) => row.url.endsWith("/name"))).toHaveLength(1);
    saveJoined("r2", HOST, { id: "p2", name: "Mina" }, KEY);
    online = true;
    stream!.destroy();
    await until(() => seen.filter((row) => row.url.includes("/stream")).length === 2);
    await vi.waitFor(() => expect(seen.filter((row) => row.url.endsWith("/name")).map((row) => row.url)).toEqual(["/room/v1/rooms/r1/name", "/room/v1/rooms/r1/name"]));
    await c.nameChanged("r1");
    expect(seen.filter((row) => row.url.endsWith("/name"))).toHaveLength(2);
  });

  it("sends to every joined room, persists the sent name, and follows the current own name", async () => {
    let name = "Mina Park";
    const state = { ...STATE, version: 2, me: { id: "p1", name: "민아 2" }, people: [{ id: "p1", name: "민아 2" }] };
    const streams: ServerResponse[] = [];
    route = (req, res, body) => {
      if (req.url?.endsWith("/name")) {
        expect(JSON.parse(body)).toEqual({ name: "민아" });
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ kind: "state", state })}\n\n`);
        return reply(res, 200, { name: "민아 2" });
      }
      if (req.url?.includes("/stream")) streams.push(res);
      quietDoor(req, res);
    };
    const c = guest({ joiner: () => ({ name, device: PC }) });
    await c.join(CODE);
    await until(() => c.room("r1")?.link === "live");
    saveJoined("r2", HOST, { id: "p1", name: "Mina" }, KEY);
    setJoinedSentName("r2", name);
    name = "민아";
    await c.nameChanged();
    await until(() => c.room("r1")?.me.name === "민아 2");
    await c.nameChanged();
    c.stop();
    c.start();
    await c.nameChanged();
    expect(seen.filter((row) => row.url.endsWith("/name")).map((row) => row.url).sort()).toEqual(["/room/v1/rooms/r1/name", "/room/v1/rooms/r2/name"]);
  });

  it("sends name updates again after rejoining a room that answered 404", async () => {
    route = (req, res) => quietDoor(req, res);
    let name = "Mina Park";
    const c = guest({ joiner: () => ({ name, device: PC }) });
    await c.join(CODE);
    await until(() => c.room("r1")?.link === "live");
    name = "민아";
    await c.nameChanged();
    await c.join(CODE);
    await until(() => c.room("r1")?.link === "live");
    name = "이서연";
    await c.nameChanged();
    expect(seen.filter((row) => row.url.endsWith("/name"))).toHaveLength(2);
  });

  it("keeps 404 quiet until the next start across later profile edits", async () => {
    let stream: ServerResponse | null = null;
    route = (req, res) => {
      if (req.url?.includes("/stream")) stream = res;
      quietDoor(req, res);
    };
    let name = "Mina Park";
    const c = guest({ joiner: () => ({ name, device: PC }), timing: { retryMs: 20 } });
    await c.join(CODE);
    await until(() => c.room("r1")?.link === "live");
    expect(typeof c.nameChanged).toBe("function");
    name = "민아";
    await c.nameChanged();
    name = "이서연";
    await c.nameChanged();
    stream!.destroy();
    await until(() => seen.filter((row) => row.url.includes("/stream")).length === 2 && c.room("r1")?.link === "live");
    await c.nameChanged();
    expect(seen.filter((row) => row.url.endsWith("/name"))).toHaveLength(1);
    expect(c.room("r1")?.me.name).toBe("Mina");
    c.stop();
    c.start();
    await until(() => seen.filter((row) => row.url.endsWith("/name")).length === 2);
  });
});

describe("bot lines", () => {
  const WINK = { id: "b1", name: "Wink", color: "blue" };
  const bot = { kind: "bot", id: "b1", name: "Wink" } as const;
  const line = (seq: number, text: string) => ({ seq, id: `e${seq}`, at: seq, author: bot, text });

  it("asks for bot authors and keeps them with the bot roster", async () => {
    const state = { ...STATE, bots: [WINK] };
    route = (req, res) => {
      if (req.url === "/room/v1/join") return reply(res, 200, { roomId: "r1", person: STATE.me, key: KEY });
      if (req.url?.includes("/snapshot")) return reply(res, 200, { head: 1, entries: [line(1, "hi")], state });
      if (req.url?.includes("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ kind: "entry", entry: line(2, "done") })}

`);
        return;
      }
      reply(res, 404, { error: "not found" });
    };
    const c = guest();
    expect((await c.join(CODE)).ok).toBe(true);
    await until(() => (c.room("r1")?.entries.length ?? 0) === 2);
    expect(seen.map((row) => row.url).slice(1)).toEqual(["/room/v1/rooms/r1/snapshot?with=bots", "/room/v1/rooms/r1/stream?after=1&with=bots&deleted=0"]);
    expect(c.room("r1")!.entries.map((entry) => entry.author)).toEqual([bot, bot]);
    expect(c.room("r1")!.state!.bots).toEqual([WINK]);
    expect(c.room("r1")!.unread).toBe(2);
  });

  it("hands on each new bot line once, never a backfill or a person's line, and a Stop", async () => {
    const mine = { kind: "bot", id: "tb-pete", name: "Pete", owner: "p1" } as const;
    const frame = (body: unknown) => `data: ${JSON.stringify(body)}

`;
    route = (req, res) => {
      if (req.url === "/room/v1/join") return reply(res, 200, { roomId: "r1", person: STATE.me, key: KEY });
      if (req.url?.includes("/snapshot")) return reply(res, 200, { head: 1, entries: [line(1, "@Pete old")], state: STATE });
      if (req.url?.includes("/bot-send")) return reply(res, 200, { entry: { seq: 4, id: "e4", at: 4, author: mine, text: "@Wink yours" } });
      if (req.url?.includes("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ kind: "entry", entry: line(2, "@Pete new") }) + frame({ kind: "entry", entry: line(2, "@Pete new") }));
        res.write(frame({ kind: "entry", entry: { seq: 3, id: "e3", at: 3, author: { kind: "person", ...STATE.me }, text: "@Pete hi" } }) + frame({ kind: "stop" }));
        return;
      }
      reply(res, 404, { error: "not found" });
    };
    const onBotLine = vi.fn();
    const onStop = vi.fn();
    const c = guest({ onBotLine, onStop });
    expect((await c.join(CODE)).ok).toBe(true);
    await until(() => onStop.mock.calls.length === 1);
    expect(c.room("r1")!.entries).toHaveLength(3);
    await c.botSend("r1", "tb-pete", "@Wink yours");
    expect(onBotLine.mock.calls.map(([roomId, entry]) => [roomId, entry.id])).toEqual([["r1", "e2"], ["r1", "e4"]]);
    expect(onStop).toHaveBeenCalledWith("r1");
  });

  it("reads an older host's state with no bots as none", async () => {
    const { bots: _bots, ...older } = STATE;
    route = (req, res) => {
      if (req.url === "/room/v1/join") return reply(res, 200, { roomId: "r1", person: STATE.me, key: KEY });
      if (req.url?.includes("/snapshot")) return reply(res, 200, { head: 0, entries: [], state: older });
      reply(res, 404, { error: "not found" });
    };
    const c = guest();
    expect((await c.join(CODE)).ok).toBe(true);
    await until(() => Boolean(c.room("r1")?.state));
    expect(c.room("r1")!.state!.bots).toEqual([]);
  });
});

describe("reactions", () => {
  it("keeps the emoji row off for an older host that sends no reactions frame", async () => {
    route = quietDoor;
    const c = guest();
    await c.join(CODE);
    await until(() => c.room("r1")?.link === "live");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(c.room("r1")?.canReact).toBe(false);
  });

  it("turns it on with the host's first reactions frame and routes a toggle to the door", async () => {
    route = (req, res, body) => {
      if (req.url?.includes("/stream")) {
        quietDoor(req, res);
        res.write(`data: ${JSON.stringify({ kind: "reactions", reset: true, lines: [{ id: "e1", marks: [{ emoji: "👍", by: "host" }] }] })}\n\n`);
        return;
      }
      if (req.url === "/room/v1/rooms/r1/react") return reply(res, 200, { marks: [{ emoji: "👍", by: "host" }, ...(JSON.parse(body).emoji === "😂" ? [{ emoji: "😂", by: "person:p1" }] : [])] });
      quietDoor(req, res);
    };
    const c = guest();
    await c.join(CODE);
    addJoinedEntries("r1", [{ seq: 1, id: "e1", at: 1, author: { kind: "host", id: "host", name: "Edward" }, text: "hi" }], 1);
    await until(() => c.room("r1")?.canReact === true);
    expect(c.room("r1")?.entries[0]?.reactions).toEqual([{ emoji: "👍", by: "host" }]);
    const res = await joinedRoute("POST", "/api/joined/rooms/r1/entries/e1/reactions", c, async () => ({ emoji: "😂" }));
    expect(res?.status).toBe(200);
    expect(JSON.parse(seen.find((row) => row.url === "/room/v1/rooms/r1/react")!.body)).toEqual({ entryId: "e1", emoji: "😂" });
    expect(c.room("r1")?.entries[0]?.reactions).toHaveLength(2);
  });
});
