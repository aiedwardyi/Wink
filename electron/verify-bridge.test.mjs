import { createHmac } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { VERIFY_GRANT_MAX_MS, VERIFY_GRANT_PREFIX } from "./verify-protocol.mjs";
import { VERIFY_LIMITS } from "../shared/live-verify.ts";
import { createVerifyBridge } from "./verify-bridge.mjs";

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
const token = "fake-private-token";
function signed(scope) { const payload = Buffer.from(JSON.stringify(scope)).toString("base64url"); return `${payload}.${createHmac("sha256", token).update(payload).digest("base64url")}`; }
async function fixture() {
  const scratch = path.join(os.tmpdir(), "wink-lv0-host"); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, "bridge-test-")));
  fs.writeFileSync(path.join(root, "index.html"), "fixture");
  const body = { runId: "run-123456", root, entry: "index.html", revision: "a".repeat(64), site: "fixture", watch: false };
  const scope = [VERIFY_GRANT_PREFIX, "bot-1", body.runId, root, body.entry, body.revision, Date.now() + 200000];
  const host = { start: vi.fn((v) => ({ runId: v.runId })), poll: vi.fn(async () => ({ revision: 2 })), watch: vi.fn(async () => ({ shown: true })), cancel: vi.fn(async () => ({ cancelled: true })), close: vi.fn(async () => {}) };
  const loadHost = vi.fn(async () => ({ createVerifyHost: () => host }));
  const bridge = createVerifyBridge({ token, loadHost });
  const server = createServer((req, res) => { void bridge.handle(req, res, new URL(req.url, "http://127.0.0.1")); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { await bridge.close(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/v1/verify/bots/bot-1/runs`;
  const call = (value = body, grant = signed(scope), suffix = "", method = "POST") => fetch(url + suffix, { method, headers: { authorization: `Bearer ${grant}` }, ...(method === "GET" ? {} : { body: typeof value === "string" ? value : JSON.stringify(value) }) });
  return { body, scope, host, loadHost, bridge, call };
}

it("authenticates frozen grants before lazy import and consumes starts once", async () => {
  const f = await fixture(); expect(VERIFY_GRANT_MAX_MS).toBe(VERIFY_LIMITS.toolMs);
  for (const index of [0, 1, 2, 3, 4, 5, 6]) {
    const scope = [...f.scope]; scope[index] = index === 6 ? Date.now() - 1 : scope[index] + "x";
    expect((await f.call(f.body, signed(scope))).status).toBe(401);
  }
  for (const grant of [token, "terminal-grant", signed(f.scope).slice(0, -1) + "!"]) expect((await f.call(f.body, grant)).status).toBe(401);
  expect(f.loadHost).not.toHaveBeenCalled();
  const replies = await Promise.all([f.call(), f.call()]);
  expect(replies.map((r) => r.status).sort()).toEqual([202, 409]);
  expect(f.host.start).toHaveBeenCalledTimes(1); expect(f.loadHost).toHaveBeenCalledTimes(1);
  expect(f.host.start.mock.calls[0][0]).toEqual({ ...f.body, botId: "bot-1" });
  expect((await f.call()).status).toBe(409);
});

it("bounds bodies, validates scope and refuses path aliases", async () => {
  const f = await fixture();
  expect((await f.call("x".repeat(65537))).status).toBe(413);
  for (const value of [{ ...f.body, extra: true }, { ...f.body, watch: 1 }, { ...f.body, site: "x".repeat(513) }]) expect((await f.call(value)).status).toBe(400);
  expect((await f.call({ ...f.body, root: f.body.root + "x" })).status).toBe(401);
  for (const entry of ["../index.html", "a/../index.html", "index.html:secret", "index%2ehtml", ".env", "a\\b.html"]) {
    const scope = [...f.scope]; scope[4] = entry;
    expect((await f.call({ ...f.body, entry }, signed(scope))).status).toBe(401);
  }
  expect(f.loadHost).not.toHaveBeenCalled();
});

it("binds poll/watch/cancel to the original scope and caps long polling", async () => {
  const f = await fixture(); await f.call();
  expect((await f.call(null, signed(f.scope), `/${f.body.runId}?since=1&waitMs=999999`, "GET")).status).toBe(200);
  expect(f.host.poll).toHaveBeenCalledWith(f.body.runId, { since: 1, waitMs: 25000 });
  expect((await f.call({}, signed(f.scope), `/${f.body.runId}/watch`)).status).toBe(200);
  expect((await f.call({}, signed(f.scope), `/${f.body.runId}/cancel`)).status).toBe(200);
  expect((await f.call("x".repeat(65537), signed(f.scope), `/${f.body.runId}/watch`)).status).toBe(413);
  const scope = [...f.scope]; scope[5] = "b".repeat(64);
  expect((await f.call(null, signed(scope), `/${f.body.runId}`, "GET")).status).toBe(401);
});

it("closes only a loaded host and awaits shutdown", async () => {
  const f = await fixture(); await f.bridge.close(); expect(f.loadHost).not.toHaveBeenCalled();
  const g = await fixture(); await g.call();
  let release; g.host.close.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  let finished = false; const pending = g.bridge.close().then(() => { finished = true; });
  await new Promise(setImmediate); expect(finished).toBe(false); release(); await pending;
  expect(g.host.close).toHaveBeenCalledTimes(1);
});
