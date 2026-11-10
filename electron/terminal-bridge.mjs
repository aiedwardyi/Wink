import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { BOT_PANE_LIMIT } from "./terminal-host.mjs";
import { handleServerErrorReport } from "./error-report-capture.mjs";

const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const GRANT_PREFIX = "orbit-terminal-read-v1";
const SEND_GRANT_PREFIX = "orbit-terminal-send-v1";
const INPUT_GRANT_PREFIX = "orbit-terminal-input-v1";
const PANE_COUNTS_GRANT_PREFIX = "orbit-terminal-pane-counts-v1";
const UPDATE_GRANT_PREFIX = "orbit-update-v1";
const MAX_SEND_BODY = 16 * 1024;
// JSON can spell each of a write's 64K chars as a 6-byte escape.
const MAX_INPUT_BODY = 6 * 64 * 1024 + 1024;

function accountRuns(value) {
  if (!Array.isArray(value)) return null;
  const runs = [];
  for (const run of value) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Worker runs cross the Electron/server process boundary.
    if (!run || typeof run !== "object" || Array.isArray(run)) return null;
    const { botId, paneId, label, engine, accountId, accountGeneration, state } = run;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Worker run fields are untyped host output.
    if (typeof botId !== "string" || typeof paneId !== "string" || label !== null && typeof label !== "string" || typeof accountId !== "string") return null;
    if (!BOT_ID_RE.test(botId) || paneId.length < 1 || paneId.length > 128 || label !== null && label.length > 40
      || !["claude", "codex"].includes(engine) || !/^[\w.-]{1,128}$/.test(accountId)
      || ["constructor", "prototype", "__proto__", ".", ".."].includes(accountId.toLowerCase())
      || !Number.isSafeInteger(accountGeneration) || accountGeneration < 0 || !["busy", "idle", "limit", "starting"].includes(state)) return null;
    runs.push({ botId, paneId, label, engine, accountId, accountGeneration, state });
  }
  return runs;
}

export function terminalReadGrant(token, botId) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token || typeof botId !== "string" || !BOT_ID_RE.test(botId)) {
    throw new Error("Invalid terminal read grant");
  }
  return createHmac("sha256", token).update(`${GRANT_PREFIX}:${botId}`).digest("base64url");
}

export function terminalSendGrant(token, botId) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token || typeof botId !== "string" || !BOT_ID_RE.test(botId)) {
    throw new Error("Invalid terminal send grant");
  }
  return createHmac("sha256", token).update(`${SEND_GRANT_PREFIX}:${botId}`).digest("base64url");
}

function terminalInputGrant(token, botId) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token || typeof botId !== "string" || !BOT_ID_RE.test(botId)) {
    throw new Error("Invalid terminal input grant");
  }
  return createHmac("sha256", token).update(`${INPUT_GRANT_PREFIX}:${botId}`).digest("base64url");
}

export function updateGrant(token) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token) throw new Error("Invalid update grant");
  return createHmac("sha256", token).update(UPDATE_GRANT_PREFIX).digest("base64url");
}

export function terminalPaneCountsGrant(token) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Grant inputs cross the Electron/server process boundary.
  if (typeof token !== "string" || !token) throw new Error("Invalid terminal pane-counts grant");
  return createHmac("sha256", token).update(PANE_COUNTS_GRANT_PREFIX).digest("base64url");
}

function plainRecord(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** Worker-pane counts from the host's paneLabels map. Main shells and empty bots are already absent. */
export function paneCountBody(labels) {
  const counts = {};
  const panes = {};
  if (!plainRecord(labels)) return { counts, panes };
  for (const [botId, names] of Object.entries(labels)) {
    if (!BOT_ID_RE.test(botId) || !Array.isArray(names) || names.length < 1 || names.length > BOT_PANE_LIMIT) continue;
    const list = [];
    for (const name of names) {
      if (Object.prototype.toString.call(name) !== "[object String]") continue;
      list.push(name.slice(0, 40));
    }
    if (!list.length) continue;
    panes[botId] = list;
    counts[botId] = list.length;
  }
  return { counts, panes };
}

function grantMatches(header, grant) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- HTTP authorization is untyped request input.
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(grant);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function bearerMatches(header, token, botId) {
  return grantMatches(header, terminalReadGrant(token, botId));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readJson(req, limit = MAX_SEND_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      if (size > limit) return;
      size += chunk.length;
      if (size > limit) return reject(Object.assign(new Error("Terminal send body too large"), { status: 413 }));
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid terminal send"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeTerminalText(text) {
  return text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

async function handleUpdate(req, res, updater, token, action) {
  if (!updater) return json(res, 404, { error: "Updater unavailable" });
  if (!grantMatches(req.headers.authorization, updateGrant(token))) return json(res, 401, { error: "Unauthorized" });
  if (req.method === "GET" && action === "state") return json(res, 200, updater.state());
  if (req.method !== "POST" || action === "state") return json(res, 405, { error: "Method not allowed" });
  if (action === "install") {
    // install quits the app, so it waits for the ack to leave
    res.once("finish", () => void Promise.resolve().then(() => updater.install()).catch(() => {}));
    return json(res, 200, updater.state());
  }
  // Only a check is awaited; a download outlives the request.
  const pending = Promise.resolve(updater[action]()).catch(() => {});
  if (action === "check") await pending;
  return json(res, 200, updater.state());
}

/** Private loopback bridge between the Electron terminal host and a scoped MCP proxy. */
export function createTerminalBridge({ host, updater, errorReports, saveCredential, verify: verifyFactory, token = randomBytes(24).toString("hex"), port = 0 } = {}) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The host is supplied by the Electron main process.
  if (!host || typeof host.readBot !== "function" || typeof host.sendBot !== "function") throw new Error("Terminal host is required");
  let server;
  let address;
  let verify;
  let closing;
  const start = () => new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      let parsed;
      try {
        parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        return json(res, 400, { error: "Invalid terminal request" });
      }
      if (parsed.pathname.startsWith("/v1/verify/") && verifyFactory) {
        try {
          verify ??= Promise.resolve(verifyFactory(token));
          if (await (await verify).handle(req, res, parsed)) return;
        }
        catch { return json(res, 500, { error: "Verify unavailable" }); }
      }
      if (parsed.pathname === "/v1/error-reports" && errorReports) return handleServerErrorReport(req, res, token, errorReports);
      if (parsed.pathname === "/v1/terminal/session") {
        if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
        try {
          const captured = host.captureWorkerSession?.(req.headers.authorization, await readJson(req));
          return json(res, captured ? 200 : 409, { captured: Boolean(captured) });
        } catch (error) {
          return json(res, error?.status === 413 ? 413 : 400, { error: "Invalid worker session" });
        }
      }
      if (parsed.pathname === "/v1/credentials") {
        if (!grantMatches(req.headers.authorization, token)) return json(res, 401, { error: "Unauthorized" });
        if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
        if (!saveCredential) return json(res, 503, { error: "desktop-unavailable" });
        try {
          const input = await readJson(req);
          await saveCredential(input?.target, input?.value);
          return json(res, 200, { saved: true });
        } catch (error) {
          if (error?.status === 400) return json(res, 400, { error: "credential-rejected" });
          return json(res, 503, { error: "credential-save-failed" });
        }
      }
      const update = parsed.pathname.match(/^\/v1\/update\/(state|check|download|install)$/);
      if (update) return handleUpdate(req, res, updater, token, update[1]);
      if (parsed.pathname === "/v1/terminal/worker-accounts") {
        if (!grantMatches(req.headers.authorization, token)) return json(res, 401, { error: "Unauthorized" });
        if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
        if (!host.enableWorkerAccounts) return json(res, 503, { error: "Worker account routing is unavailable" });
        host.enableWorkerAccounts();
        return json(res, 200, { enabled: true });
      }
      if (parsed.pathname === "/v1/terminal/account-runs") {
        if (!grantMatches(req.headers.authorization, terminalPaneCountsGrant(token))) return json(res, 401, { error: "Unauthorized" });
        if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
        const botId = parsed.searchParams.get("botId");
        const engine = parsed.searchParams.get("engine");
        if (botId !== null && !BOT_ID_RE.test(botId) || engine !== null && !["claude", "codex"].includes(engine)) return json(res, 400, { error: "Invalid worker run filter" });
        try {
          const filter = {};
          if (botId !== null) filter.botId = botId;
          if (engine !== null) filter.engine = engine;
          const runs = accountRuns(host.liveAccountRuns?.(filter));
          if (runs) return json(res, 200, { runs });
        } catch {}
        return json(res, 503, { error: "Worker account runs are unavailable" });
      }
      if (parsed.pathname === "/v1/terminal/account-panes") {
        if (!grantMatches(req.headers.authorization, terminalPaneCountsGrant(token))) return json(res, 401, { error: "Unauthorized" });
        if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
        const accountId = parsed.searchParams.get("accountId") ?? "";
        if (!/^[\w.-]{1,128}$/.test(accountId)) return json(res, 400, { error: "Invalid account" });
        try {
          return json(res, 200, host.livePanesForAccount?.(accountId) ?? { count: 0, unknown: 1, generations: {} });
        } catch {
          return json(res, 503, { count: 0, unknown: 1, generations: {} });
        }
      }
      if (parsed.pathname === "/v1/terminal/pane-counts") {
        if (!grantMatches(req.headers.authorization, terminalPaneCountsGrant(token))) return json(res, 401, { error: "Unauthorized" });
        if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
        try {
          const labels = host.paneLabels ? host.paneLabels() : {};
          return json(res, 200, paneCountBody(labels));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json(res, 500, { error: message });
        }
      }
      const match = parsed.pathname.match(/^\/v1\/bots\/([a-zA-Z0-9_-]{1,128})\/terminal(?:\/(send|open|main|attention|close|stream|input|resize))?$/);
      if (!match || !BOT_ID_RE.test(match[1])) return json(res, 404, { error: "Unknown terminal route" });
      const botId = match[1];
      const sendOnly = match[2] === "send" && grantMatches(req.headers.authorization, terminalSendGrant(token, botId));
      const live = match[2] === "input" || match[2] === "resize";
      const typing = live && grantMatches(req.headers.authorization, terminalInputGrant(token, botId));
      if (!sendOnly && !typing && !bearerMatches(req.headers.authorization, token, botId)) return json(res, 401, { error: "Unauthorized" });
      if (live && !typing) return json(res, 403, { error: "Forbidden" });
      try {
        const sessionId = parsed.searchParams.get("sessionId");
        if (req.method === "GET" && !match[2]) {
          const waitFor = parsed.searchParams.get("waitFor");
          const timeoutParam = parsed.searchParams.get("timeoutMs");
          const options = {};
          if (sessionId) options.sessionId = sessionId;
          if (parsed.searchParams.get("panes") === "1") options.panesOnly = true;
          if (parsed.searchParams.get("observe") === "1") options.observe = true;
          if (waitFor) options.waitFor = waitFor;
          if (waitFor && timeoutParam) options.timeoutMs = Number(timeoutParam);
          return json(res, 200, await host.readBot(botId, options));
        }
        if (req.method === "GET" && match[2] === "stream") {
          const watch = host.watchBot(botId, sessionId, {
            send: (frame) => { res.write(`${JSON.stringify(frame)}\n`); return res.writableLength; },
            end: () => res.end(),
            drop: () => res.destroy(),
          });
          res.once("close", watch.stop);
          res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
          const line = `${JSON.stringify(watch.snapshot)}\n`;
          return void (watch.snapshot.exitCode === null ? res.write(line) : res.end(line));
        }
        if (req.method === "POST" && match[2] === "input") {
          await host.inputBot(botId, await readJson(req, MAX_INPUT_BODY));
          return json(res, 200, { sent: true });
        }
        if (req.method === "POST" && match[2] === "resize") {
          await host.resizeBot(botId, await readJson(req));
          return json(res, 200, { resized: true });
        }
        if (req.method === "DELETE" && !match[2]) {
          await host.closeBotPanes(botId);
          return json(res, 200, { closed: true });
        }
        if (req.method === "POST" && match[2] === "open") return json(res, 200, await host.openForBot(botId, await readJson(req)));
        if (req.method === "POST" && match[2] === "main") {
          await host.openMainForBot(botId);
          return json(res, 200, host.readBot(botId));
        }
        if (req.method === "POST" && match[2] === "close") {
          const input = await readJson(req);
          const result = await host.closeForBot(botId, input?.sessionId, input?.keep === true);
          return json(res, 200, result?.alreadyClosed === true ? { closed: true, alreadyClosed: true } : { closed: true });
        }
        if (req.method === "POST" && match[2] === "attention") {
          const note = await readJson(req);
          return json(res, 200, { raised: host.attendBot(botId, note?.sessionId, note?.kind, note?.text) });
        }
        if (req.method === "POST" && match[2]) {
          const input = await readJson(req);
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Terminal text is untyped HTTP request input.
          if (input && typeof input === "object" && typeof input.text === "string") input.text = normalizeTerminalText(input.text);
          await host.sendBot(botId, input, { person: sendOnly });
          return json(res, 200, host.readBot(botId, input?.sessionId ? { sessionId: input.sessionId, observe: true } : undefined));
        }
        return json(res, 405, { error: "Method not allowed" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error?.status === 413) return json(res, 413, { error: message });
        const status = /stale|No active|exited|Unknown terminal/i.test(message) ? 409 : /Too many/i.test(message) ? 429 : /Invalid|unavailable/i.test(message) ? 400 : 500;
        return json(res, status, { error: message });
      }
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      address = server.address();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's server address is a string for named pipes.
      if (!address || typeof address === "string") return reject(new Error("Terminal bridge did not bind"));
      resolve({ url: `http://127.0.0.1:${address.port}`, token });
    });
  });
  const close = () => closing ??= Promise.all([
    Promise.resolve(verify).then(value => value?.close()).catch(() => {}),
    new Promise((resolve) => { if (server) server.close(() => resolve()); else resolve(); }),
  ]).then(() => {});
  return {
    start,
    close,
    credentials: () => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's server address is a string for named pipes.
      if (!address || typeof address === "string") return null;
      return { url: `http://127.0.0.1:${address.port}`, token };
    },
  };
}
