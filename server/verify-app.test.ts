import dns from "node:dns";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { appEntry, appUrls } from "./verify-app.ts";
import { createVerifyAuto, type VerifyAutoTurn } from "./verify-auto.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
const servers: { server: Server; sockets: Set<Socket> }[] = [];
let root: string;
let start: ReturnType<typeof vi.fn<(input: { botId: string; threadId: string; entry: string; episode: string }) => Promise<void>>>;
let log: ReturnType<typeof vi.fn<(line: string) => void>>;
let turn: VerifyAutoTurn;

const track = (server: Server) => {
  const row = { server, sockets: new Set<Socket>() };
  server.on("connection", socket => { row.sockets.add(socket); socket.on("close", () => row.sockets.delete(socket)); });
  servers.push(row);
  return server;
};
const listen = async (server: Server, port = 0) => {
  await new Promise<void>(done => track(server).listen(port, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
};
const page = (type = "text/html") => createHttp((_, res) => { res.writeHead(200, { "content-type": type }); res.end(type.includes("html") ? "<a href='/gone'>Gone</a>" : "{}"); });
const slow = () => createTcp(socket => {
  let drips = 0;
  socket.on("error", () => {});
  socket.write("HTTP/1.1 200 OK\r\n");
  const drip = setInterval(() => {
    if (++drips < 25) return void socket.write("x-wait: 1\r\n");
    clearInterval(drip);
    socket.end("content-type: text/html\r\n\r\n<h1>Hi</h1>");
  }, 40);
  socket.on("close", () => clearInterval(drip));
});
const freePort = async () => {
  const server = createTcp();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(done => server.close(() => done()));
  return port;
};
const event = (fields: Partial<RuntimeEvent>) => ({ eventId: "e", provider: "claudeAgent", threadId: "thread", turnId: "turn", createdAt: new Date().toISOString(), ...fields }) as RuntimeEvent;
const verifier = (app: { waitMs?: number; skipPorts?: number[] } = {}) =>
  createVerifyAuto({ enabled: () => true, freeMemory: () => 8 * 1024 ** 3, startAuto: start, log, app: { waitMs: 400, ...app } });
const shell = (auto: ReturnType<typeof createVerifyAuto>) => {
  auto.event(event({ type: "item.started", itemType: "tool", itemId: "shell", title: "Bash" }));
  auto.event(event({ type: "item.completed", itemType: "tool", itemId: "shell", ok: true }));
};
const wrote = (auto: ReturnType<typeof createVerifyAuto>, writes: string[]) => auto.event(event({ type: "item.completed", itemType: "tool", ok: true, writes }));

beforeEach(async () => {
  root = await realpath(temps.make(join(tmpdir(), "wink-verify-app-")));
  await writeFile(join(root, "app.py"), "app = Flask(__name__)");
  start = vi.fn().mockResolvedValue(undefined);
  log = vi.fn();
  turn = { botId: "bot", threadId: "thread", turnId: "turn", startedAt: Date.now(), roots: [root], depth: 0, ok: true, humanId: "human", humanText: "Build the app", reply: "" };
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server, sockets }) => new Promise<void>(done => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return done();
    server.close(() => done());
  })));
  await temps.remove();
  vi.restoreAllMocks();
});

it("checks the app URL a shell turn names", async () => {
  const port = await listen(page());
  const auto = verifier();
  shell(auto);
  await auto.settled({ ...turn, reply: `Flask is up at http://127.0.0.1:${port}/ - try it.` });
  expect(start.mock.calls[0]?.[0].entry).toBe(`http://127.0.0.1:${port}/`);
});

it.each([
  ["Open localhost:%d", "http://localhost:%d/"],
  ["Running on 0.0.0.0:%d/home", "http://127.0.0.1:%d/home"],
  ["See **http://127.0.0.1:%d**.", "http://127.0.0.1:%d/"],
])("checks the named form %s", async (reply, entry) => {
  const port = await listen(page());
  const auto = verifier();
  shell(auto);
  await auto.settled({ ...turn, reply: reply.replace("%d", String(port)) });
  expect(start.mock.calls[0]?.[0].entry).toBe(entry.replace("%d", String(port)));
});

it("checks the user's named URL after an edit outside the bot's roots", async () => {
  const port = await listen(page());
  const auto = verifier();
  wrote(auto, [join(tmpdir(), "elsewhere", "src", "App.tsx")]);
  await auto.settled({ ...turn, humanText: `Fix the header on http://localhost:${port}`, reply: "Fixed the header." });
  expect(start.mock.calls[0]?.[0].entry).toBe(`http://localhost:${port}/`);
});

it("checks the running app, not its template file", async () => {
  const port = await listen(page());
  await mkdir(join(root, "templates"));
  await writeFile(join(root, "templates", "index.html"), "<h1>{{ title }}</h1>");
  const auto = verifier();
  wrote(auto, ["app.py", "templates/index.html"]);
  await auto.settled({ ...turn, reply: `Running on http://127.0.0.1:${port}` });
  expect(start.mock.calls[0]?.[0].entry).toBe(`http://127.0.0.1:${port}/`);
});

it("waits for a server that starts after the turn", async () => {
  const port = await freePort();
  const auto = verifier({ waitMs: 5_000 });
  shell(auto);
  const settled = auto.settled({ ...turn, reply: `Vite: http://127.0.0.1:${port}/` });
  setTimeout(() => void listen(page(), port), 600);
  await settled;
  expect(start.mock.calls[0]?.[0].entry).toBe(`http://127.0.0.1:${port}/`);
});

it.each(["refused", "silent", "slow", "json", "own port"])("does not check a named URL that is %s", async kind => {
  await writeFile(join(root, "package.json"), "{}");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "App.tsx"), "export default () => null");
  const port = kind === "refused" ? await freePort() : await listen(kind === "silent" ? createTcp() : kind === "slow" ? slow() : page(kind === "json" ? "application/json" : "text/html"));
  const auto = verifier(kind === "own port" ? { skipPorts: [port] } : {});
  wrote(auto, ["src/App.tsx"]);
  await auto.settled({ ...turn, reply: `Open http://127.0.0.1:${port}/` });
  expect(start).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("Live Verify: no entry for thread");
});

it("stays quiet for a chat-only reply naming a running app", async () => {
  const port = await listen(page());
  const auto = verifier();
  await auto.settled({ ...turn, reply: `Your app is still at http://127.0.0.1:${port}` });
  expect(start).not.toHaveBeenCalled();
});

it("reads only named http loopback URLs, at most three", () => {
  expect(appUrls("https://localhost:3000, localhost alone, me@localhost:25, http://localhost:3000/a/b), [::1]:4000 and http://127.0.0.1 or 127.0.0.1:5000"))
    .toEqual(["http://localhost:3000/a/b", "http://[::1]:4000/", "http://127.0.0.1/"]);
});

it("skips hosts and ports that only start like loopback", () => {
  expect(appUrls("http://localhost.example.com:3000/ http://localhost-api:8080 localhost:300000 http://127.0.0.10:3000/ 127.0.0.1:5000abc, but localhost:3000."))
    .toEqual(["http://localhost:3000/"]);
});

it("rejects loopback-looking hosts that carry credentials", () => {
  expect(appUrls("http://localhost:3000@evil.example/ localhost:3000@evil.example http://localhost@evil.example/ http://u:p@localhost:3000/")).toEqual([]);
});

it("never resolves localhost, so a hijacked resolver cannot redirect the probe", async () => {
  const port = await listen(page());
  const lookup = vi.spyOn(dns, "lookup").mockImplementation(((_host: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === "function" ? options : callback;
    (options as { all?: boolean })?.all ? cb(null, [{ address: "192.0.2.1", family: 4 }]) : cb(null, "192.0.2.1", 4);
  }) as unknown as typeof dns.lookup);
  expect(await appEntry(`http://localhost:${port}/`, { waitMs: 1_500 })).toBe(`http://localhost:${port}/`);
  expect(lookup).not.toHaveBeenCalled();
});

it("aborts every other probe once one URL wins", async () => {
  const seen = [0, 0];
  let release = () => {};
  const gate = new Promise<void>(done => { release = done; });
  const winner = createHttp((_, res) => void gate.then(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>Hi</h1>"); }));
  const quiet = seen.map((_, index) => createTcp(socket => { socket.resume(); socket.on("error", () => {}); seen[index]!++; if (seen.every(Boolean)) release(); }));
  const ports = [await listen(winner), ...(await Promise.all(quiet.map(server => listen(server))))];
  const urls = ports.map(port => `http://127.0.0.1:${port}/`);
  expect(await appEntry(urls.join(" "), { waitMs: 20_000 })).toBe(urls[0]);
  const open = () => servers.slice(1).reduce((sum, { sockets }) => sum + sockets.size, 0);
  const until = Date.now() + 1_000;
  while (open() && Date.now() < until) await new Promise(done => setTimeout(done, 20));
  expect(open()).toBe(0);
});
