import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import os from "node:os";
import { createTerminalBridge, paneCountBody, terminalPaneCountsGrant, terminalReadGrant, terminalSendGrant, updateGrant } from "./terminal-bridge.mjs";
import { BOT_PANE_TOTAL, createTerminalHost } from "./terminal-host.mjs";
import { closeBotPanes } from "../server/terminal-cleanup.ts";
import { createWorkerLaunch } from "../server/worker-launch.ts";
import { terminalPaneCountsGrant as serverTerminalPaneCountsGrant, terminalSendGrant as serverTerminalSendGrant, updateGrant as serverUpdateGrant } from "../server/terminal-grant.ts";

test("delegates verify routes and awaits verify shutdown", async (t) => {
  let factoryToken;
  let release;
  const bridge = createTerminalBridge({
    host: { readBot: () => ({ text: "terminal" }), sendBot() {} },
    verify: (token) => {
      factoryToken = token;
      return {
        handle(req, res, url) { res.writeHead(202).end(JSON.stringify({ path: url.pathname })); return true; },
        close: () => new Promise((resolve) => { release = resolve; }),
      };
    },
  });
  t.after(() => { release?.(); return bridge.close(); });
  const access = await bridge.start();
  assert.equal(factoryToken, undefined);
  const response = await fetch(`${access.url}/v1/verify/bots/bot-1/runs`, { method: "POST", body: "x".repeat(20000) });
  assert.equal(response.status, 202);
  assert.equal(factoryToken, access.token);
  assert.deepEqual(await response.json(), { path: "/v1/verify/bots/bot-1/runs" });
  const headers = { authorization: `Bearer ${terminalReadGrant(access.token, "bot-1")}` };
  assert.equal((await fetch(`${access.url}/v1/bots/bot-1/terminal/send`, { method: "POST", headers, body: JSON.stringify({ text: "x".repeat(20000) }) })).status, 413);
  let closed = false;
  const pending = bridge.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  release();
  await pending;
});

test("does not load verification during terminal bridge startup or shutdown", async () => {
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {} }, verify: () => { assert.fail("Verification loaded without a run"); } });
  await bridge.start();
  await bridge.close();
});

function accountRunFixture(t) {
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  const host = createTerminalHost({
    authorize() {}, owner: () => owner, resolveCwd: async () => os.tmpdir(),
    platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 64 * 1024 ** 3,
    workerLaunch: async ({ command }) => command === "shell" ? null : ({
      kind: command === "side" ? "unrouted" : "managed", executable: command === "codex" ? "codex" : "claude", args: [],
      account: { id: command === "codex" ? "codex.fixture" : "claude.fixture", generation: 2 }, environment: {},
    }),
    loadPty: () => ({ spawn: () => {
      const child = { writes: [], onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(text) { this.writes.push(text); }, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
  });
  const bridge = createTerminalBridge({ host });
  t.after(async () => { await bridge.close(); await host.dispose(); });
  return { host, bridge, children, owner };
}

test("lists live worker runs with account and bot", async (t) => {
  const f = accountRunFixture(t);
  const access = await f.bridge.start();
  const one = await f.host.openForBot("bot-1", { label: "builder", command: "claude" });
  const two = await f.host.openForBot("bot-2", { label: "checker", command: "codex" });
  const headers = { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` };
  const url = `${access.url}/v1/terminal/account-runs`;
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const runs = [
    { botId: "bot-1", paneId: one.sessionId, label: "builder", engine: "claude", accountId: "claude.fixture", accountGeneration: 2, state: "starting" },
    { botId: "bot-2", paneId: two.sessionId, label: "checker", engine: "codex", accountId: "codex.fixture", accountGeneration: 2, state: "starting" },
  ];
  assert.deepEqual(await response.json(), { runs });
  assert.deepEqual(await (await fetch(`${url}?botId=bot-2&engine=codex`, { headers })).json(), { runs: [runs[1]] });
  assert.deepEqual(await (await fetch(`${url}?engine=claude`, { headers })).json(), { runs: [runs[0]] });
  assert.deepEqual(await (await fetch(`${url}?botId=absent`, { headers })).json(), { runs: [] });
  const counts = await fetch(`${access.url}/v1/terminal/account-panes?accountId=claude.fixture`, { headers });
  assert.deepEqual(await counts.json(), { count: 1, unknown: 0, generations: { 2: 1 } });
});

test("leaves side-door, user and exited panes out", async (t) => {
  const f = accountRunFixture(t);
  const access = await f.bridge.start();
  await f.host.open({ sender: f.owner }, { botId: "bot-1", cols: 80, rows: 24 });
  for (const command of ["side", "shell", "claude", "codex"]) await f.host.openForBot("bot-1", { label: command, command });
  f.children[3].exit({ exitCode: 0 });
  const pane = f.host.readBot("bot-1").panes.at(-1);
  f.children[4].data(`\x1b]133;C;${pane.sessionId};${Buffer.alloc(32).toString("base64")}\x07\x1b]133;D;${pane.sessionId};0\x07`);
  const response = await fetch(`${access.url}/v1/terminal/account-runs`, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { runs: [] });
  for (const row of f.host.readBot("bot-1", { panesOnly: true }).panes.slice(0, 3)) assert.equal(Object.hasOwn(row, "account"), false);
});

test("refuses an unauthenticated or bad-filter request", async (t) => {
  let calls = 0;
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, liveAccountRuns() { calls++; return []; } } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const url = `${access.url}/v1/terminal/account-runs`;
  for (const token of ["", access.token, terminalReadGrant(access.token, "bot-1"), terminalSendGrant(access.token, "bot-1"), updateGrant(access.token)]) {
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  }
  const headers = { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` };
  for (const query of ["?botId=", "?botId=a.b", `?botId=${"a".repeat(129)}`, "?engine=", "?engine=shell"]) assert.equal((await fetch(`${url}${query}`, { headers })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers })).status, 405);
  assert.equal(calls, 0);
});

test("reports host errors and malformed run output as unavailable", async (t) => {
  let result = [];
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, liveAccountRuns() { if (result instanceof Error) throw result; return result; } } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  for (result of [new Error("private host failure"), {}, [{ botId: "bot-1", paneId: "pane", label: null, engine: "claude", accountId: "claude.fixture", accountGeneration: -1, state: "busy" }]]) {
    const response = await fetch(`${access.url}/v1/terminal/account-runs`, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Worker account runs are unavailable" });
  }
});

test("rejects reserved account ids in worker run output", async (t) => {
  let accountId;
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, liveAccountRuns: () => [
    { botId: "bot-1", paneId: "pane", label: null, engine: "claude", accountId, accountGeneration: 0, state: "busy" },
  ] } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  for (accountId of ["constructor", "Constructor", "prototype", "__proto__", ".", ".."]) {
    const response = await fetch(`${access.url}/v1/terminal/account-runs`, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` } });
    assert.equal(response.status, 503, accountId);
    assert.deepEqual(await response.json(), { error: "Worker account runs are unavailable" });
  }
});

test("strips unknown keys from worker run output", async (t) => {
  const run = { botId: "bot-1", paneId: "pane", label: null, engine: "claude", accountId: "claude.fixture", accountGeneration: 0, state: "busy" };
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, liveAccountRuns: () => [{ ...run, extra: "private" }] } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const response = await fetch(`${access.url}/v1/terminal/account-runs`, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { runs: [run] });
});

for (const [name, input] of [["fractional generations", { accountGeneration: 0.5 }], ["41-character labels", { label: "a".repeat(41) }]]) {
  test(`rejects ${name} in worker run output`, async (t) => {
    const run = { botId: "bot-1", paneId: "pane", label: null, engine: "claude", accountId: "claude.fixture", accountGeneration: 0, state: "busy", ...input };
    const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, liveAccountRuns: () => [run] } });
    t.after(() => bridge.close());
    const access = await bridge.start();
    const response = await fetch(`${access.url}/v1/terminal/account-runs`, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Worker account runs are unavailable" });
  });
}

test("credential saves require the full bridge bearer, never terminal or updater grants", async (t) => {
  const calls = [];
  const bridge = createTerminalBridge({
    host: { readBot() {}, sendBot() {} },
    saveCredential: async (...args) => { calls.push(args); },
  });
  t.after(() => bridge.close());
  const access = await bridge.start();
  for (const token of ["", "wrong", terminalReadGrant(access.token, "bot"), terminalSendGrant(access.token, "bot"), updateGrant(access.token)]) {
    const response = await fetch(`${access.url}/v1/credentials`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ target: "ttsKey", value: "test-only-key" }),
    });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  }
});

test("credential saves confirm only after the owning desktop finishes and never echo its result", async (t) => {
  let confirm;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const calls = [];
  const bridge = createTerminalBridge({
    host: { readBot() {}, sendBot() {} },
    saveCredential: async (...args) => {
      calls.push(args);
      entered();
      await new Promise((resolve) => { confirm = resolve; });
      return { key: "test-only-key" };
    },
  });
  t.after(() => bridge.close());
  const access = await bridge.start();
  let answered = false;
  const pending = fetch(`${access.url}/v1/credentials`, {
    method: "POST", headers: { authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ target: "custom:api.acme.dev", value: "test-only-key" }),
  }).then((response) => { answered = true; return response; });
  await Promise.race([started, pending]);
  assert.equal(answered, false);
  assert.deepEqual(calls, [["custom:api.acme.dev", "test-only-key"]]);
  confirm();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { saved: true });
});

test("credential store failures stay private and do not log or echo the key", async (t) => {
  const bridge = createTerminalBridge({
    host: { readBot() {}, sendBot() {} },
    saveCredential: async () => { throw new Error("test-only-key"); },
  });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const response = await fetch(`${access.url}/v1/credentials`, {
    method: "POST", headers: { authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ target: "ttsKey", value: "test-only-key" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "credential-save-failed" });
});

test("owner HTTP 400 credential rejections use a fixed code without forwarding text", async (t) => {
  const bridge = createTerminalBridge({
    host: { readBot() {}, sendBot() {} },
    saveCredential: async () => { throw Object.assign(new Error("private provider reason"), { status: 400 }); },
  });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const response = await fetch(`${access.url}/v1/credentials`, {
    method: "POST", headers: { authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ target: "ttsKey", value: "test-only-key" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "credential-rejected" });
});

test("owner auth and conflict errors are save failures, not rejected keys", async (t) => {
  let status;
  const bridge = createTerminalBridge({
    host: { readBot() {}, sendBot() {} },
    saveCredential: async () => { throw Object.assign(new Error("private owner reason"), { status }); },
  });
  t.after(() => bridge.close());
  const access = await bridge.start();
  for (status of [401, 403, 409, 500]) {
    const response = await fetch(`${access.url}/v1/credentials`, {
      method: "POST", headers: { authorization: `Bearer ${access.token}` },
      body: JSON.stringify({ target: "ttsKey", value: "test-only-key" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "credential-save-failed" });
  }
});

test("requires the private bearer and scopes reads to the requested bot", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot(botId) {
        calls.push(["read", botId]);
        return { botId, sessionId: "s1", generation: 1, screenText: "ready", seq: 4, capturedAt: 1, truncated: false };
      },
      sendBot(botId, input) {
        calls.push(["send", botId, input]);
        return { ok: true };
      },
    },
  });
  const connection = await bridge.start();
  const unauthorized = await fetch(`${connection.url}/v1/bots/bot-1/terminal`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${connection.url}/v1/bots/bot-1/terminal`, { headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { botId: "bot-1", sessionId: "s1", generation: 1, screenText: "ready", seq: 4, capturedAt: 1, truncated: false });
  assert.deepEqual(calls, [["read", "bot-1"]]);
  const crossBot = await fetch(`${connection.url}/v1/bots/bot-2/terminal`, { headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` } });
  assert.equal(crossBot.status, 401);
  await bridge.close();
});

function sendFixture() {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot: (botId) => ({ botId, sessionId: "s1", generation: 2, screenText: "echo exact", seq: 5, capturedAt: 7, exited: false, truncated: false }),
      async sendBot(botId, input) {
        calls.push([botId, input]);
        if (input.generation !== 2) throw new Error("Terminal session is stale; take a fresh snapshot");
        return { id: input.sessionId, output: "raw" };
      },
    },
  });
  return { bridge, calls };
}

const sendRequest = (connection, init = {}) => fetch(`${connection.url}/v1/bots/bot-1/terminal/send`, {
  method: "POST",
  headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
  ...init,
});

test("forwards turn-end text and explicit read observation to the host", async (t) => {
  const calls = [];
  const bridge = createTerminalBridge({ host: {
    readBot: (...args) => { calls.push(args); return {}; },
    sendBot() {},
    attendBot: (...args) => { calls.push(args); return true; },
  } });
  t.after(() => bridge.close());
  const connection = await bridge.start();
  const headers = { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" };
  const note = await fetch(`${connection.url}/v1/bots/bot-1/terminal/attention`, { method: "POST", headers, body: JSON.stringify({ sessionId: "worker", kind: "auto", text: "done" }) });
  assert.deepEqual(await note.json(), { raised: true });
  await fetch(`${connection.url}/v1/bots/bot-1/terminal?sessionId=worker&observe=1`, { headers });
  assert.deepEqual(calls, [["bot-1", "worker", "auto", "done"], ["bot-1", { sessionId: "worker", observe: true }]]);
});

test("forwards panes-only reads and keeps full reads unchanged", async (t) => {
  const calls = [];
  const panes = [{ sessionId: "worker", label: "build", main: false, exited: false, changedAt: 42 }];
  const bridge = createTerminalBridge({ host: {
    readBot: (botId, options) => {
      calls.push([botId, options]);
      return options.panesOnly ? { botId, panes } : { botId, panes, screenText: "ready", screenRuns: [], recentText: "done" };
    },
    sendBot() {},
  } });
  t.after(() => bridge.close());
  const connection = await bridge.start();
  const headers = { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` };
  const response = await fetch(`${connection.url}/v1/bots/bot-1/terminal?panes=1`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { botId: "bot-1", panes });
  const full = await fetch(`${connection.url}/v1/bots/bot-1/terminal`, { headers });
  assert.equal((await full.json()).screenText, "ready");
  await fetch(`${connection.url}/v1/bots/bot-1/terminal?sessionId=worker&panes=1`, { headers });
  assert.deepEqual(calls, [["bot-1", { panesOnly: true }], ["bot-1", {}], ["bot-1", { sessionId: "worker", panesOnly: true }]]);
});

test("the snapshot terminal_send returns counts as a read", async (t) => {
  const calls = [];
  const bridge = createTerminalBridge({ host: { readBot: (...args) => { calls.push(args); return {}; }, sendBot() {} } });
  t.after(() => bridge.close());
  const connection = await bridge.start();
  await sendRequest(connection, { body: JSON.stringify({ sessionId: "worker", generation: 1, text: "ls\r" }) });
  assert.deepEqual(calls, [["bot-1", { sessionId: "worker", observe: true }]]);
});

test("sends text to the bot's own terminal and returns the read-shaped snapshot", async () => {
  const { bridge, calls } = sendFixture();
  const connection = await bridge.start();
  const response = await sendRequest(connection, { body: JSON.stringify({ sessionId: "s1", generation: 2, text: "echo exact\r" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { botId: "bot-1", sessionId: "s1", generation: 2, screenText: "echo exact", seq: 5, capturedAt: 7, exited: false, truncated: false });
  assert.deepEqual(calls, [["bot-1", { sessionId: "s1", generation: 2, text: "echo exact\r" }]]);
  await bridge.close();
});

test("rejects a stale generation with 409", async () => {
  const { bridge } = sendFixture();
  const connection = await bridge.start();
  const response = await sendRequest(connection, { body: JSON.stringify({ sessionId: "s1", generation: 1, text: "old\r" }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /stale/);
  await bridge.close();
});

test("only POST reaches the send route", async () => {
  const { bridge, calls } = sendFixture();
  const connection = await bridge.start();
  const response = await sendRequest(connection, { method: "GET" });
  assert.equal(response.status, 405);
  assert.deepEqual(calls, []);
  await bridge.close();
});

test("rejects oversized and malformed send bodies before the host", async () => {
  const { bridge, calls } = sendFixture();
  const connection = await bridge.start();
  const oversized = await sendRequest(connection, { body: JSON.stringify({ sessionId: "s1", generation: 2, text: "x".repeat(17 * 1024) }) });
  assert.equal(oversized.status, 413);
  const malformed = await sendRequest(connection, { body: "{" });
  assert.equal(malformed.status, 400);
  const crossBot = await fetch(`${connection.url}/v1/bots/bot-2/terminal/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` },
    body: JSON.stringify({ sessionId: "s1", generation: 2, text: "x\r" }),
  });
  assert.equal(crossBot.status, 401);
  assert.deepEqual(calls, []);
  await bridge.close();
});

test("accepts the send grant on the send route only", async () => {
  const { bridge, calls } = sendFixture();
  const connection = await bridge.start();
  const auth = { authorization: `Bearer ${terminalSendGrant(connection.token, "bot-1")}`, "content-type": "application/json" };
  const body = JSON.stringify({ sessionId: "s1", generation: 2, text: "ls\n" });
  const sent = await fetch(`${connection.url}/v1/bots/bot-1/terminal/send`, { method: "POST", headers: auth, body });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).screenText, "echo exact");
  assert.deepEqual(calls, [["bot-1", { sessionId: "s1", generation: 2, text: "ls\r" }]]);
  assert.equal((await fetch(`${connection.url}/v1/bots/bot-2/terminal/send`, { method: "POST", headers: auth, body })).status, 401);
  assert.equal((await fetch(`${connection.url}/v1/bots/bot-1/terminal`, { headers: auth })).status, 401);
  assert.equal((await fetch(`${connection.url}/v1/bots/bot-1/terminal`, { method: "DELETE", headers: auth })).status, 401);
  for (const route of ["open", "attention", "close"]) {
    assert.equal((await fetch(`${connection.url}/v1/bots/bot-1/terminal/${route}`, { method: "POST", headers: auth, body: "{}" })).status, 401);
  }
  assert.equal(calls.length, 1);
  await bridge.close();
});

test("a person's send types an engine command into the main terminal whole, a bot's stays refused", async (t) => {
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  const host = createTerminalHost({
    authorize() {}, owner: () => owner, resolveCwd: async () => os.tmpdir(),
    platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 64 * 1024 ** 3,
    workerLaunch: createWorkerLaunch({ enabled: () => true }),
    loadPty: () => ({ spawn: () => {
      const child = { writes: [], onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(text) { this.writes.push(text); }, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
  });
  const bridge = createTerminalBridge({ host });
  t.after(async () => { await bridge.close(); await host.dispose(); });
  const connection = await bridge.start();
  const main = await host.openMainForBot("bot-1");
  const send = (grant, text) => fetch(`${connection.url}/v1/bots/bot-1/terminal/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${grant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify({ ...main, text }),
  });
  const before = children[0].writes.length;
  assert.notEqual((await send(terminalReadGrant, "codex\n")).status, 200);
  assert.deepEqual(children[0].writes.slice(before), []);
  assert.equal((await send(terminalSendGrant, "codex\n")).status, 200);
  assert.deepEqual(children[0].writes.slice(before), ["codex\r"]);
});

test("send grant matches the server's", () => {
  assert.equal(terminalSendGrant("bridge-secret", "bot-1"), serverTerminalSendGrant("bridge-secret", "bot-1"));
  assert.notEqual(terminalSendGrant("bridge-secret", "bot-1"), terminalReadGrant("bridge-secret", "bot-1"));
});

test("pane-counts grant matches the server's and is not a per-bot read", () => {
  assert.equal(terminalPaneCountsGrant("bridge-secret"), serverTerminalPaneCountsGrant("bridge-secret"));
  assert.notEqual(terminalPaneCountsGrant("bridge-secret"), terminalReadGrant("bridge-secret", "bot-1"));
  assert.notEqual(terminalPaneCountsGrant("bridge-secret"), updateGrant("bridge-secret"));
});

test("GET /v1/terminal/pane-counts returns worker counts for that grant only", async () => {
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot: () => ({}),
      sendBot: () => ({}),
      paneLabels: () => ({ "bot-1": ["w1", "w2"], "bot-2": ["other"], "nope": [] }),
    },
  });
  const connection = await bridge.start();
  const headers = { authorization: `Bearer ${terminalPaneCountsGrant(connection.token)}` };
  const response = await fetch(`${connection.url}/v1/terminal/pane-counts`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { counts: { "bot-1": 2, "bot-2": 1 }, panes: { "bot-1": ["w1", "w2"], "bot-2": ["other"] } });
  assert.equal((await fetch(`${connection.url}/v1/terminal/pane-counts`)).status, 401);
  assert.equal((await fetch(`${connection.url}/v1/terminal/pane-counts`, { headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}` } })).status, 401);
  assert.equal((await fetch(`${connection.url}/v1/terminal/pane-counts`, { method: "POST", headers })).status, 405);
  assert.deepEqual(paneCountBody(null), { counts: {}, panes: {} });
  await bridge.close();
});

test("pane counts keep a bot with more than 8 workers, up to its home and remote total", () => {
  const labels = (n) => Array.from({ length: n }, (_, i) => `w${i}`);
  assert.equal(paneCountBody({ "bot-1": labels(9) }).counts["bot-1"], 9);
  assert.equal(paneCountBody({ "bot-1": labels(192) }).counts["bot-1"], 192);
  assert.deepEqual(paneCountBody({ "bot-1": labels(193) }), { counts: {}, panes: {} });
  assert.equal(BOT_PANE_TOTAL, 192);
});

test("opens a pane only for the grant's own bot", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot: (botId) => ({ botId }),
      sendBot: () => ({}),
      async openForBot(botId, input) {
        calls.push([botId, input]);
        if (input.label === "full") throw new Error("Too many bot terminals (limit 128)");
        return { sessionId: "p1", generation: 1 };
      },
    },
  });
  const connection = await bridge.start();
  const open = (botId, body) => fetch(`${connection.url}/v1/bots/${botId}/terminal/open`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await open("bot-1", { label: "worker", command: "ls" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessionId: "p1", generation: 1 });
  assert.equal((await open("bot-2", { label: "worker" })).status, 401);
  assert.equal((await open("bot-1", { label: "full" })).status, 429);
  assert.deepEqual(calls.map(([botId, input]) => [botId, input.label]), [["bot-1", "worker"], ["bot-1", "full"]]);
  await bridge.close();
});

test("opens the main shell only for the grant's own bot and answers its snapshot", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: {
      readBot: (botId) => ({ botId, sessionId: "m1", generation: 1 }),
      sendBot: () => ({}),
      async openMainForBot(botId) {
        calls.push(botId);
        if (botId === "bot-3") throw new Error("Terminal folder is unavailable");
        return { sessionId: "m1", generation: 1 };
      },
    },
  });
  const connection = await bridge.start();
  const open = (botId, grantBot = botId) => fetch(`${connection.url}/v1/bots/${botId}/terminal/main`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, grantBot)}` },
  });
  try {
    const response = await open("bot-1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { botId: "bot-1", sessionId: "m1", generation: 1 });
    assert.equal((await open("bot-2", "bot-1")).status, 401);
    assert.equal((await open("bot-3")).status, 400);
    assert.deepEqual(calls, ["bot-1", "bot-3"]);
  } finally {
    await bridge.close();
  }
});

test("raises pane attention for the granted bot only", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: { readBot: () => ({}), sendBot: () => ({}), attendBot: (botId, sessionId, kind) => { calls.push([botId, sessionId, kind]); return true; } },
  });
  const connection = await bridge.start();
  const attend = (botId, kind) => fetch(`${connection.url}/v1/bots/${botId}/terminal/attention`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "p1", kind }),
  });
  const response = await attend("bot-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { raised: true });
  assert.equal((await attend("bot-2")).status, 401);
  await attend("bot-1", "report");
  assert.deepEqual(calls, [["bot-1", "p1", undefined], ["bot-1", "p1", "report"]]);
  await bridge.close();
});

test("closes a pane for the granted bot only", async () => {
  const calls = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: { readBot: () => ({}), sendBot: () => ({}), closeForBot: async (botId, sessionId) => { calls.push([botId, sessionId]); } },
  });
  const connection = await bridge.start();
  const close = (botId) => fetch(`${connection.url}/v1/bots/${botId}/terminal/close`, {
    method: "POST",
    headers: { authorization: `Bearer ${terminalReadGrant(connection.token, "bot-1")}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "p1" }),
  });
  const response = await close("bot-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { closed: true });
  assert.equal((await close("bot-2")).status, 401);
  assert.deepEqual(calls, [["bot-1", "p1"]]);
  await bridge.close();
});

test("close passes keep through to scratch cleanup", async (t) => {
  const calls = [];
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, closeForBot: async (...args) => { calls.push(args); } } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const response = await fetch(`${access.url}/v1/bots/bot/terminal/close`, {
    method: "POST", headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot")}` },
    body: JSON.stringify({ sessionId: "pane", keep: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["bot", "pane", true]]);
});

test("deleted bot cleanup retires its spawned panes through the bridge", async () => {
  const events = [];
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send: (...args) => events.push(args) };
  const host = createTerminalHost({
    authorize: () => {}, owner: () => owner, resolveCwd: async () => os.tmpdir(),
    platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 64 * 1024 ** 3,
    loadPty: () => ({ spawn: () => {
      const child = { killed: false, onData() {}, onExit() {}, write() {}, resize() {}, kill() { this.killed = true; } };
      children.push(child);
      return child;
    } }),
  });
  const bridge = createTerminalBridge({ host });
  try {
    const access = await bridge.start();
    const main = await host.open({ sender: owner }, { botId: "bot-1", cols: 80, rows: 24 });
    const one = await host.openForBot("bot-1", { label: "one" });
    const two = await host.openForBot("bot-1", { label: "two" });
    const foreign = await host.openForBot("bot-2", { label: "foreign" });
    const unauthorized = await fetch(`${access.url}/v1/bots/bot-1/terminal`, { method: "DELETE" });
    assert.equal(unauthorized.status, 401);
    const crossBot = await fetch(`${access.url}/v1/bots/bot-1/terminal`, {
      method: "DELETE", headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot-2")}` },
    });
    assert.equal(crossBot.status, 401);
    await closeBotPanes(access, "bot-1");
    await closeBotPanes(access, "bot-1");
    assert.deepEqual(children.map((child) => child.killed), [false, true, true, false]);
    assert.deepEqual(host.readBot("bot-1").panes.map((pane) => pane.sessionId), [main.id]);
    assert.equal(host.readBot("bot-2").panes[0].sessionId, foreign.sessionId);
    assert.deepEqual(events.filter(([channel]) => channel === "terminal:closed").map(([, event]) => event.id), [one.sessionId, two.sessionId]);
  } finally {
    await bridge.close();
    host.dispose();
  }
});

for (const stage of ["folder", "ready"]) {
  test(`deleted bot cleanup rejects a pane pending ${stage}`, async () => {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const waiting = new Promise((resolve) => { entered = resolve; });
    const children = [];
    const events = [];
    const owner = { id: 1, isDestroyed: () => false, send: (...args) => events.push(args) };
    const host = createTerminalHost({
      authorize: () => {}, owner: () => owner,
      resolveCwd: async () => {
        if (stage === "folder") { entered(); await gate; }
        return os.tmpdir();
      },
      platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 64 * 1024 ** 3,
      loadPty: () => ({ spawn: () => {
        const child = { killed: false, writes: [], ready: stage === "ready" ? gate : Promise.resolve(), onData() {}, onExit() {}, write(text) { this.writes.push(text); }, resize() {}, kill() { this.killed = true; } };
        children.push(child);
        if (stage === "ready") entered();
        return child;
      } }),
    });
    const bridge = createTerminalBridge({ host });
    try {
      const access = await bridge.start();
      const opening = host.openForBot("bot-1", { label: "pending", command: "worker-cli" });
      const rejected = assert.rejects(opening, /deleted/);
      await waiting;
      await closeBotPanes(access, "bot-1");
      assert.equal(children.some((child) => child.killed), false);
      release();
      await rejected;
      assert.deepEqual(host.readBot("bot-1").panes, []);
      assert.ok(children.every((child) => child.killed && child.writes.length === 0));
      assert.equal(events.some(([channel]) => channel === "terminal:opened"), false);
      await assert.rejects(host.openForBot("bot-1"), /deleted/);
    } finally {
      release();
      await bridge.close();
      host.dispose();
    }
  });
}

function updaterFixture() {
  const calls = [];
  let state = { status: "available", version: "1.0.53", appVersion: "1.0.52" };
  const updater = {
    state: () => state,
    check: async () => {
      calls.push("check");
      state = { ...state, status: "idle" };
    },
    download: () => {
      calls.push("download");
      state = { ...state, status: "downloading" };
      return new Promise(() => {});
    },
    install: () => {
      calls.push("install");
      state = { ...state, status: "installing" };
    },
  };
  return { calls, bridge: createTerminalBridge({ token: "bridge-secret", host: { readBot() {}, sendBot() {} }, updater }) };
}

test("serves the updater behind its own grant", async () => {
  const { bridge, calls } = updaterFixture();
  const connection = await bridge.start();
  const auth = { authorization: `Bearer ${updateGrant(connection.token)}` };
  assert.equal((await fetch(`${connection.url}/v1/update/state`)).status, 401);
  const botGrant = { authorization: `Bearer ${terminalReadGrant(connection.token, "update")}` };
  assert.equal((await fetch(`${connection.url}/v1/update/state`, { headers: botGrant })).status, 401);
  const state = await fetch(`${connection.url}/v1/update/state`, { headers: auth });
  assert.deepEqual(await state.json(), { status: "available", version: "1.0.53", appVersion: "1.0.52" });
  assert.equal((await fetch(`${connection.url}/v1/update/state`, { method: "POST", headers: auth })).status, 405);
  assert.equal((await fetch(`${connection.url}/v1/update/install`, { headers: auth })).status, 405);
  const download = await fetch(`${connection.url}/v1/update/download`, { method: "POST", headers: auth });
  assert.equal((await download.json()).status, "downloading");
  const check = await fetch(`${connection.url}/v1/update/check`, { method: "POST", headers: auth });
  assert.equal((await check.json()).status, "idle");
  const install = await fetch(`${connection.url}/v1/update/install`, { method: "POST", headers: auth });
  assert.equal((await install.json()).status, "idle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["download", "check", "install"]);
  await bridge.close();
});

test("acks install before the updater quits the app", async () => {
  let response;
  const onRequest = (message) => (response = message.response);
  subscribe("http.server.request.start", onRequest);
  const acked = [];
  const bridge = createTerminalBridge({
    token: "bridge-secret",
    host: { readBot() {}, sendBot() {} },
    updater: { state: () => ({ status: "downloaded" }), install: () => acked.push(response.writableFinished) },
  });
  try {
    const connection = await bridge.start();
    const install = await fetch(`${connection.url}/v1/update/install`, { method: "POST", headers: { authorization: `Bearer ${updateGrant(connection.token)}` } });
    assert.deepEqual(await install.json(), { status: "downloaded" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(acked, [true]);
  } finally {
    unsubscribe("http.server.request.start", onRequest);
    await bridge.close();
  }
});

test("reports the updater missing when the bridge has none", async () => {
  const bridge = createTerminalBridge({ token: "bridge-secret", host: { readBot() {}, sendBot() {} } });
  const connection = await bridge.start();
  const response = await fetch(`${connection.url}/v1/update/state`, { headers: { authorization: `Bearer ${updateGrant(connection.token)}` } });
  assert.equal(response.status, 404);
  await bridge.close();
});

test("update grant matches the server's", () => {
  assert.equal(updateGrant("bridge-secret"), serverUpdateGrant("bridge-secret"));
});

const inputGrant = (token, botId) => createHmac("sha256", token).update(`orbit-terminal-input-v1:${botId}`).digest("base64url");

function liveFixture(t) {
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  const host = createTerminalHost({
    authorize() {}, owner: () => owner, resolveCwd: async () => os.tmpdir(),
    platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 64 * 1024 ** 3,
    loadPty: () => ({ spawn: () => {
      const child = { writes: [], sizes: [], paused: 0, onData(cb) { this.data = cb; }, onExit(cb) { this.exit = cb; }, write(text) { this.writes.push(text); }, resize(cols, rows) { this.sizes.push([cols, rows]); }, pause() { this.paused++; }, kill() {} };
      children.push(child);
      return child;
    } }),
  });
  const watches = [];
  const watchBot = host.watchBot?.bind(host);
  host.watchBot = (botId, sessionId, viewer) => {
    const entry = { sends: 0, dropped: false };
    let stopped;
    entry.stopped = new Promise((resolve) => { stopped = resolve; });
    const watch = watchBot(botId, sessionId, {
      send: (frame) => { entry.sends++; return viewer.send(frame); },
      end: viewer.end,
      drop: () => { entry.dropped = true; viewer.drop(); },
    });
    watches.push(entry);
    return { snapshot: watch.snapshot, stop: () => { watch.stop(); stopped(); } };
  };
  const bridge = createTerminalBridge({ host });
  t.after(async () => { await host.dispose(); await bridge.close(); });
  return { host, bridge, children, owner, watches };
}

async function openLive(f) {
  const access = await f.bridge.start();
  const pane = await f.host.open({ sender: f.owner }, { botId: "bot-1", cols: 80, rows: 24 });
  return { access, pane, child: f.children[0] };
}

function readLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
    }
    const index = buffered.indexOf("\n");
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    return JSON.parse(line);
  };
}

const streamRequest = (access, grant, query = "", init = {}) => fetch(`${access.url}/v1/bots/bot-1/terminal/stream${query}`, { headers: { authorization: `Bearer ${grant}` }, ...init });

test("streams the snapshot first, then chunks in seq order", async (t) => {
  const f = liveFixture(t);
  const { access, pane, child } = await openLive(f);
  child.data("\x1b[?2004hbefore\r\n");
  const read = terminalReadGrant(access.token, "bot-1");
  const response = await streamRequest(access, read, `?sessionId=${pane.sessionId}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /ndjson/);
  const next = readLines(response.body);
  assert.deepEqual(await next(), { sessionId: pane.sessionId, generation: pane.generation, output: "\x1b[?2004hbefore\r\n", seq: 1, cols: 80, rows: 24, modes: [2004], resetModes: [], exitCode: null });
  child.data("one");
  child.data("two");
  assert.deepEqual(await next(), { seq: 2, data: "one" });
  assert.deepEqual(await next(), { seq: 3, data: "two" });
  await f.host.resize({ sender: f.owner }, pane.sessionId, 100, 30);
  assert.deepEqual(await next(), { cols: 100, rows: 30 });
  child.exit({ exitCode: 0 });
  assert.deepEqual(await next(), { exitCode: 0 });
  assert.equal(await next(), null);
  await f.watches[0].stopped;
  const exited = readLines((await streamRequest(access, read)).body);
  assert.equal((await exited()).exitCode, 0);
  assert.equal(await exited(), null);
  assert.equal((await streamRequest(access, terminalReadGrant(access.token, "bot-2"))).status, 401);
  assert.equal((await fetch(`${access.url}/v1/bots/bot-2/terminal/stream`, { headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot-2")}` } })).status, 409);
});

test("a viewer that throws is dropped without starving the others", async (t) => {
  const f = liveFixture(t);
  const { pane, child } = await openLive(f);
  const frames = [];
  let dropped = 0;
  f.host.watchBot("bot-1", pane.sessionId, { send() { throw new Error("gone"); }, end() {}, drop() { dropped++; } });
  f.host.watchBot("bot-1", pane.sessionId, { send: (frame) => { frames.push(frame); return 0; }, end() {}, drop() {} });
  assert.doesNotThrow(() => child.data("a"));
  child.data("b");
  assert.deepEqual([dropped, frames], [1, [{ seq: 1, data: "a" }, { seq: 2, data: "b" }]]);
});

test("does no stream work for a pane nobody watches and forgets a closed viewer", async (t) => {
  const f = liveFixture(t);
  const { access, child } = await openLive(f);
  const idle = () => {
    const stringify = t.mock.method(JSON, "stringify");
    const timeout = t.mock.method(globalThis, "setTimeout");
    const interval = t.mock.method(globalThis, "setInterval");
    child.data("idle output\r\n");
    const counts = [stringify.mock.callCount(), timeout.mock.callCount(), interval.mock.callCount()];
    t.mock.restoreAll();
    return counts;
  };
  assert.deepEqual(idle(), [0, 0, 0]);
  const controller = new AbortController();
  const response = await streamRequest(access, terminalReadGrant(access.token, "bot-1"), "", { signal: controller.signal });
  assert.equal(response.status, 200);
  const next = readLines(response.body);
  assert.equal((await next()).seq, 1);
  child.data("watched");
  assert.deepEqual(await next(), { seq: 2, data: "watched" });
  controller.abort();
  await f.watches[0].stopped;
  const sends = f.watches[0].sends;
  assert.deepEqual(idle(), [0, 0, 0]);
  assert.equal(f.watches[0].sends, sends);
});

test("drops a viewer more than 1 MB behind without pausing the pane", async (t) => {
  const f = liveFixture(t);
  const { access, child } = await openLive(f);
  const response = await new Promise((resolve, reject) => {
    const req = http.get(`${access.url}/v1/bots/bot-1/terminal/stream`, { headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot-1")}` } }, resolve);
    req.on("error", reject);
  });
  assert.equal(response.statusCode, 200);
  response.on("error", () => {});
  response.pause();
  const chunk = `${"x".repeat(1023)}\n`.repeat(64);
  for (let i = 0; i < 512 && !f.watches[0].dropped; i++) child.data(chunk);
  assert.equal(f.watches[0].dropped, true);
  const sends = f.watches[0].sends;
  child.data(chunk);
  assert.equal(f.watches[0].sends, sends);
  assert.equal(child.paused, 0);
  const controller = new AbortController();
  const again = await streamRequest(access, terminalReadGrant(access.token, "bot-1"), "", { signal: controller.signal });
  assert.equal(again.status, 200);
  assert.equal((await readLines(again.body)()).output.length, 256 * 1024);
  controller.abort();
});

test("types raw keys and resizes only with the input grant", async (t) => {
  const f = liveFixture(t);
  const { access, pane, child } = await openLive(f);
  const post = (route, grant, body) => fetch(`${access.url}/v1/bots/bot-1/terminal/${route}`, { method: "POST", headers: { authorization: `Bearer ${grant}` }, body: JSON.stringify(body) });
  const key = { sessionId: pane.sessionId, generation: pane.generation, data: "\x03" };
  const size = { sessionId: pane.sessionId, generation: pane.generation, cols: 120, rows: 40 };
  const read = terminalReadGrant(access.token, "bot-1");
  assert.equal((await post("input", read, key)).status, 403);
  assert.equal((await post("resize", read, size)).status, 403);
  assert.equal((await post("input", terminalSendGrant(access.token, "bot-1"), key)).status, 401);
  const writes = child.writes.length;
  assert.deepEqual(child.sizes, []);
  const input = inputGrant(access.token, "bot-1");
  const typed = await post("input", input, key);
  assert.equal(typed.status, 200);
  assert.deepEqual(await typed.json(), { sent: true });
  assert.deepEqual(child.writes.slice(writes), ["\x03"]);
  assert.equal((await post("resize", input, size)).status, 200);
  assert.deepEqual(child.sizes, [[120, 40]]);
  assert.equal((await post("resize", input, { ...size, cols: 501 })).status, 400);
  assert.equal((await post("resize", input, { ...size, rows: 0 })).status, 400);
  assert.equal((await post("input", input, { ...key, data: "x".repeat(64 * 1024 + 1) })).status, 400);
  assert.equal((await post("input", input, { ...key, generation: pane.generation + 1 })).status, 409);
  assert.equal((await post("input", inputGrant(access.token, "bot-2"), key)).status, 401);
  assert.equal((await streamRequest(access, input)).status, 401);
  assert.deepEqual(child.writes.slice(writes), ["\x03"]);
});
