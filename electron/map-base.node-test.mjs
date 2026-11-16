import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mapBase } from "./map-base.mjs";
import { createPaneRuns } from "./pane-runs.mjs";
import { createMapEvents } from "./map-events.mjs";
import { createTerminalBridge, terminalReadGrant } from "./terminal-bridge.mjs";

test("captures launch HEAD and persists it while tolerating older pane records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-map-base-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8" }).trim();
    assert.equal(await mapBase(root), null);
    git("init", "-q");
    fs.writeFileSync(path.join(root, "a.txt"), "before\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
    const head = git("rev-parse", "HEAD");
    assert.equal(await mapBase(root), head);
    const file = path.join(root, "panes.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "old", state: "running", cwd: root }]));
    const runs = createPaneRuns(file);
    runs.started({ id: "new", botId: "bot", cwd: root, baseHead: head, spawnedAt: Date.now() });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.find(run => run.id === "new").baseHead, head);
    assert.equal(saved.find(run => run.id === "old").baseHead, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("streams only the watched bot's pane lifecycle and detaches on close", async () => {
  const events = createMapEvents();
  const bridge = createTerminalBridge({ host: { readBot: () => ({ panes: [] }), sendBot() {}, watchMap: events.watch } });
  const access = await bridge.start();
  const abort = new AbortController();
  try {
    const url = `${access.url}/v1/bots/bot/terminal/map-events`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot")}` } })).status, 405);
    const response = await fetch(url, { headers: { authorization: `Bearer ${terminalReadGrant(access.token, "bot")}` }, signal: abort.signal });
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "{}\n");
    events.emit("other");
    events.emit("bot");
    assert.equal(new TextDecoder().decode((await reader.read()).value), "{}\n");
    abort.abort();
  } finally { abort.abort(); await bridge.close(); }
});
