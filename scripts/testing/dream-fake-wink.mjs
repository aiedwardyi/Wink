// Stand-in for the Wink server the practice kit boots per arm: the routes winkEngine drives, bots kept on disk across a
// restart, and a log of starts and turns. FAKE_WINK: "die-first" (the first start exits before ready), "send-drop" or
// "read-drop" (the socket closes on the send or on the answer read).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const data = process.env.OMB_DATA_DIR;
const fault = process.env.FAKE_WINK ?? "";
const log = (row) => appendFileSync(process.env.FAKE_WINK_LOG, `${JSON.stringify({ pid: process.pid, ...row })}\n`);
if (fault === "die-first" && !existsSync(join(data, "died"))) {
  writeFileSync(join(data, "died"), "");
  process.exit(1);
}
const saved = join(data, "fake-bots.json");
const bots = new Map(existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : []);
// recall builds its index for the bots it finds at start
const known = new Set(bots.keys());
const threads = new Map([...bots.values()].map((threadId) => [threadId, []]));
const streams = new Set();
const emit = (event) => {
  for (const res of streams) res.write(`data: ${JSON.stringify({ kind: "event", event })}\n\n`);
};
const body = (req) => new Promise((done) => {
  let text = "";
  req.on("data", (chunk) => (text += chunk));
  req.on("end", () => done(text ? JSON.parse(text) : {}));
});
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (req.headers.authorization !== `Bearer ${process.env.OMB_COMMS_TOKEN}`) return json(res, 401, {});
  if (req.method === "GET" && path === "/api/bots") return json(res, 200, { bots: [] });
  if (req.method === "GET" && path === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"kind":"hello"}\n\n');
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (req.method === "GET" && path === "/api/instances") return json(res, 200, { instances: [{ instanceId: "fake", driverKind: "claudeAgent" }] });
  if (req.method === "POST" && path === "/api/bots") {
    await body(req);
    const id = `kit-${process.pid}-${bots.size + 1}`;
    bots.set(id, `thread-${id}`);
    threads.set(`thread-${id}`, []);
    writeFileSync(saved, JSON.stringify([...bots]));
    return json(res, 201, { bot: { id, threadId: `thread-${id}` } });
  }
  let m = path.match(/^\/api\/bots\/([\w-]+)$/);
  if (m && req.method === "PATCH") {
    await body(req);
    return json(res, 200, {});
  }
  m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
  if (m && req.method === "POST") {
    const { text, sendId } = await body(req);
    if (fault === "send-drop") return req.socket.destroy();
    const threadId = bots.get(m[1]);
    const messages = threads.get(threadId);
    log({ turn: m[1], threadId, prior: messages.length, indexed: known.has(m[1]) });
    messages.push({ sendId, role: "user", kind: "text", text });
    json(res, 202, {});
    setTimeout(() => {
      messages.push({ role: "bot", kind: "text", text: `answer to ${text}` });
      emit({ type: "turn.completed", threadId, ok: true, usage: { input: 1000, cachedInput: 0, output: 100 } });
    }, 50);
    return;
  }
  m = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
  if (m && req.method === "GET") {
    if (fault === "read-drop") return req.socket.destroy();
    return json(res, 200, { messages: threads.get(m[1]) ?? [] });
  }
  if (req.method === "POST" && /\/(?:respond|interrupt)$/.test(path)) return json(res, 200, {});
  json(res, 404, {});
}).listen(Number(process.env.OMB_PORT), "127.0.0.1", () => log({ start: Number(process.env.OMB_PORT), known: [...known] }));
