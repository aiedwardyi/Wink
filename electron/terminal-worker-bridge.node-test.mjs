import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalBridge, terminalPaneCountsGrant, terminalReadGrant } from "./terminal-bridge.mjs";

test("only the private host bearer can enable worker account enforcement", async (t) => {
  let enabled = false;
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, enableWorkerAccounts() { enabled = true; } } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const url = `${access.url}/v1/terminal/worker-accounts`;
  const denied = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot")}` } });
  assert.equal(denied.status, 401);
  assert.equal(enabled, false);
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${access.token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true });
  assert.equal(enabled, true);
});

test("account pane counts require the fleet grant and preserve unknown uses", async (t) => {
  const calls = [];
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {}, livePanesForAccount(id) { calls.push(id); return { count: 2, unknown: 1, generations: { "3": 2 } }; } } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const url = `${access.url}/v1/terminal/account-panes?accountId=acct_third`;
  const denied = await fetch(url, { headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot")}` } });
  assert.equal(denied.status, 401);
  const response = await fetch(url, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 2, unknown: 1, generations: { "3": 2 } });
  assert.deepEqual(calls, ["acct_third"]);
});

test("older hosts cannot enable accounts or claim an empty account pane count", async (t) => {
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {} } });
  t.after(() => bridge.close());
  const access = await bridge.start();
  const enabled = await fetch(`${access.url}/v1/terminal/worker-accounts`, { method: "POST", headers: { authorization: `Bearer ${access.token}` } });
  assert.equal(enabled.status, 503);
  const counts = await fetch(`${access.url}/v1/terminal/account-panes?accountId=codex`, { headers: { authorization: `Bearer ${terminalPaneCountsGrant(access.token)}` } });
  assert.deepEqual(await counts.json(), { count: 0, unknown: 1, generations: {} });
});
