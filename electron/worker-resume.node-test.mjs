import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPaneRuns, restartNoteText } from "./pane-runs.mjs";
import { createTerminalHost } from "./terminal-host.mjs";
import { RESUME_NUDGE } from "../server/worker-resume.ts";

const recovery = await import("./worker-resume.mjs").catch(() => null);
const ROOT = path.join(os.tmpdir(), "wink-SURVIVE-2");
const NUDGE = "Wink restarted and resumed this conversation. Your last step may not have finished. Check the real state first (git status, git log, remote branch, test output) and skip anything already done. Never redo a push, merge or release unless you confirm it did not happen; if unsure, report BLOCKED with what you found. Then continue the card.";

function record(engine = "codex", changes = {}) {
  const id = randomUUID();
  return { id, botId: "bot", teacher: "teacher", label: engine, cwd: ROOT, spawnedAt: 0, state: "running",
    session: { pane: id, launchGeneration: randomUUID(), engine, nativeId: randomUUID(), cwd: ROOT,
      accountId: engine, accountGeneration: 0, model: "fixture", effort: "high", lifecycle: "running", source: "startup",
      template: { executable: engine, args: ["--model", "fixture", "original task"] } }, ...changes };
}

function fixture(t, rows = [record()]) {
  const dir = path.join(ROOT, randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pane-runs.json");
  fs.writeFileSync(file, JSON.stringify(rows));
  const runs = createPaneRuns(file);
  const launched = [];
  const notes = [];
  const waits = [];
  const closed = [];
  const host = {
    async openForBot(bot, input, run) {
      assert.equal(bot, run.botId);
      assert.equal(input.cwd, run.cwd);
      assert.equal(input.label, run.label);
      if (!runs.claim(run.id)) throw new Error("Recovery already claimed");
      launched.push(run);
      return { sessionId: `new-${run.id}` };
    },
    workerResumeStatus: () => "resumed",
    async closeForBot(bot, id) { closed.push({ bot, id }); },
  };
  const options = { runs, host, mailbox: async () => ({ token: "fake" }), notePane: async (_mail, scope, text) => notes.push({ scope, text }),
    wait: async (ms) => { waits.push(ms); }, polls: 2, settleMs: 0, retryMs: 0 };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { file, runs, host, launched, notes, waits, closed, options };
}

for (const engine of ["claude", "codex"]) {
  test(`two ${engine} panes in one cwd resume their own ids in stagger order and notify their teacher once`, async (t) => {
    assert.ok(recovery);
    const rows = [record(engine, { label: "ONE" }), record(engine, { label: "TWO" })];
    const f = fixture(t, rows);
    await recovery.recoverWorkers(f.options);
    assert.deepEqual(f.launched.map((run) => run.session.nativeId), rows.map((run) => run.session.nativeId));
    assert.equal(f.waits.filter((ms) => ms === 2000).length, 1);
    assert.equal(f.notes.length, 1);
    assert.equal(f.notes[0].scope.teacher, "teacher");
    assert.match(f.notes[0].text, new RegExp(`^RESUMED:.*ONE \\(${engine}\\).*TWO \\(${engine}\\)`, "s"));
    assert.doesNotMatch(f.notes[0].text, /FRESH/);
    assert.equal(RESUME_NUDGE, NUDGE);
  });
}

test("claims survive a crash before spawn and cannot be consumed twice", (t) => {
  const row = record();
  const f = fixture(t, [row]);
  assert.equal(f.runs.claim(row.id), true);
  assert.equal(f.runs.claim(row.id), false);
  assert.equal(createPaneRuns(f.file).claim(row.id), false);
});

test("a failed atomic claim rolls back memory and never authorizes a spawn", (t) => {
  const row = record();
  const f = fixture(t, [row]);
  const before = fs.readFileSync(f.file, "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("disk unavailable"); });
  assert.equal(f.runs.claim(row.id), false);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  rename.mock.restore();
  assert.equal(f.runs.claim(row.id), true);
});

test("legacy templates, unconfirmed ids and missing ids keep RESTARTED guidance", async (t) => {
  assert.ok(recovery);
  const rows = [record(), record(), record(), record("grok")];
  delete rows[0].session.template;
  delete rows[1].session.source;
  rows[2].session.nativeId = null;
  const f = fixture(t, rows);
  await recovery.recoverWorkers(f.options);
  assert.equal(f.launched.length, 0);
  assert.match(f.notes[0].text, /RESTARTED:.*no launch template.*no confirmed id.*no id.*FRESH/s);
  assert.doesNotMatch(f.notes[0].text, /RESUMED:/);
});

test("malformed template metadata does not prevent recovery of another pane", async (t) => {
  assert.ok(recovery);
  const rows = [record(), record()];
  rows[0].session.template.executable = {};
  const f = fixture(t, rows);
  await recovery.recoverWorkers(f.options);
  assert.deepEqual(f.launched.map((run) => run.id), [rows[1].id]);
  assert.match(f.notes[0].text, /no launch template/);
});

test("other engines keep the existing RESTARTED note verbatim", async (t) => {
  assert.ok(recovery);
  const row = record("grok", { label: null });
  const f = fixture(t, [row]);
  await recovery.recoverWorkers(f.options);
  assert.equal(f.notes[0].text, restartNoteText([row]));
});

test("reported, ended and closed records never return", async (t) => {
  assert.ok(recovery);
  const f = fixture(t, [record("claude", { state: "reported" }), record("codex", { state: "ended" }), record("codex", { state: "closed" })]);
  await recovery.recoverWorkers(f.options);
  assert.equal(f.launched.length, 0);
  assert.equal(f.notes.length, 0);
});

test("prior-process callbacks cannot confirm a recovery claim", (t) => {
  const row = record();
  const f = fixture(t, [row]);
  assert.equal(f.runs.claim(row.id), true);
  assert.equal(f.runs.capture({ pane: row.id, launchGeneration: row.session.launchGeneration,
    session_id: row.session.nativeId, cwd: ROOT, transcript_path: null, source: "resume" }), false);
});

for (const reason of ["resume failed", "unexpected menu"]) {
  test(`${reason} stops retries after submission and keeps fallback guidance`, async (t) => {
    assert.ok(recovery);
    const f = fixture(t);
    f.host.workerResumeStatus = () => reason;
    await recovery.recoverWorkers(f.options);
    assert.equal(f.launched.length, 1);
    assert.match(f.notes[0].text, /RESTARTED:.*resume failed|RESTARTED:.*unexpected menu/s);
    assert.match(f.notes[0].text, /FRESH/);
  });
}

test("prelaunch failures retry finitely and a claim prevents retry after an uncertain spawn", async (t) => {
  assert.ok(recovery);
  const f = fixture(t, [record(), record()]);
  let calls = 0;
  f.host.openForBot = async (_bot, _input, run) => {
    calls++;
    if (run.id === f.runs.restarted().get("bot")[0].id) throw new Error("service unavailable");
    f.runs.claim(run.id);
    throw new Error("spawn acknowledgement lost");
  };
  await recovery.recoverWorkers(f.options);
  assert.equal(calls, 4);
  assert.match(f.notes[0].text, /resume failed/);
});

test("a usage hold never gets retried into an automatic policy bypass", async (t) => {
  assert.ok(recovery);
  const f = fixture(t);
  let calls = 0;
  f.host.openForBot = async () => { calls++; return { hold: "usage low" }; };
  await recovery.recoverWorkers(f.options);
  assert.equal(calls, 1);
  assert.match(f.notes[0].text, /resume held by usage policy/);
});

test("a previous claim never spawns again on a later boot", async (t) => {
  assert.ok(recovery);
  const row = record();
  const f = fixture(t, [row]);
  f.runs.claim(row.id);
  await recovery.recoverWorkers({ ...f.options, runs: createPaneRuns(f.file) });
  assert.equal(f.launched.length, 0);
  assert.match(f.notes[0].text, /RESTARTED:.*resume interrupted/s);
});

test("a crash after replacement or its report never revives the original pane", (t) => {
  const row = record();
  const f = fixture(t, [row]);
  assert.equal(f.runs.claim(row.id), true);
  const replacement = { ...row, id: randomUUID(), session: { ...row.session, recoveredFrom: row.id } };
  f.runs.started(replacement);
  assert.equal(f.runs.restarted().get("bot").length, 1);
  assert.deepEqual(createPaneRuns(f.file).restarted().get("bot").map((run) => run.id), [replacement.id]);
  f.runs.reported(replacement.id);
  assert.equal(createPaneRuns(f.file).restarted().size, 0);
});

test("mixed recovery notes keep FRESH guidance confined to failed panes", async (t) => {
  assert.ok(recovery);
  const rows = [record("claude"), record("codex")];
  const f = fixture(t, rows);
  const open = f.host.openForBot;
  f.host.openForBot = async (...args) => {
    if (args[2].session.engine === "codex") throw new Error("Worker account is unavailable or signed out");
    return open(...args);
  };
  await recovery.recoverWorkers(f.options);
  const [resumed, restarted] = f.notes[0].text.split("\nRESTARTED:");
  assert.match(resumed, /^RESUMED: claude \(claude\)/);
  assert.doesNotMatch(resumed, /codex|FRESH/);
  assert.match(restarted, /codex \(account signed out or unavailable\)/);
  assert.doesNotMatch(restarted, /claude/);
});

for (const status of ["pending", "resume failed", "unexpected menu"]) {
  test(`${status} closes only its replacement before FRESH guidance`, async (t) => {
    const rows = [record("claude"), record("codex")];
    const f = fixture(t, rows);
    f.host.workerResumeStatus = (id) => id === `new-${rows[0].id}` ? status : "resumed";
    let finishClose;
    const closing = new Promise((resolve) => { finishClose = resolve; });
    f.host.closeForBot = async (bot, id) => { f.closed.push({ bot, id }); await closing; };
    const recovering = recovery.recoverWorkers(f.options);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.notes.length, 0);
    assert.deepEqual(f.closed, [{ bot: "bot", id: `new-${rows[0].id}` }]);
    finishClose();
    await recovering;
    assert.match(f.notes[0].text, /FRESH/);
    assert.match(f.notes[0].text, /^RESUMED: codex/);
  });
}

test("a failed replacement close never sends FRESH guidance", async (t) => {
  const f = fixture(t);
  f.host.workerResumeStatus = () => "pending";
  f.host.closeForBot = async () => { throw new Error("close failed"); };
  await assert.rejects(recovery.recoverWorkers(f.options), /close failed/);
  assert.equal(f.notes.length, 0);
});

for (const text of ["The test failed to load configuration. I will fix it now.", "Error resuming the upload; retrying.", "No conversation found in the test fixture."]) {
  test(`ordinary output does not fail recovery: ${text}`, () => {
    const session = { exitCode: null, screen: { text: () => text }, workerSession: {} };
    assert.equal(recovery.workerResumeStatus(session), "pending");
    session.workerSession.confirmed = "resume";
    assert.equal(recovery.workerResumeStatus(session), "resumed");
  });
}

test("confirmed recovery cannot be downgraded by screen diagnostics or menus", () => {
  const session = { exitCode: null, screen: { text: () => "No conversation found with session ID: 00000000-0000-4000-8000-000000000001\nSign in to continue" }, workerSession: { confirmed: "resume" } };
  assert.equal(recovery.workerResumeStatus(session), "resumed");
});

test("does not fail a resume on a screen Wink answers", () => {
  const text = "Accessing workspace:\nYes, I trust this folder\nEnter to confirm · Esc to cancel";
  const session = { exitCode: null, worker: true, botPane: true, engine: "claude", screen: { text: () => text }, claudeStartupScreen: text };
  assert.equal(recovery.workerResumeStatus(session), "pending");
  session.claudeStartupScreen = null;
  assert.equal(recovery.workerResumeStatus(session), "unexpected menu");
  session.claudeStartupScreen = text;
  session.workerSession = { confirmed: "resume" };
  assert.equal(recovery.workerResumeStatus(session), "resumed");
});

for (const text of [
  "No conversation found with session ID: 00000000-0000-4000-8000-000000000001",
  "Error: No saved session found with ID 00000000-0000-4000-8000-000000000001. Run `codex resume` without an ID to choose from existing sessions.",
  "Failed to resume session from C:\\scratch\\rollout.jsonl: invalid session",
]) {
  test(`CLI resume diagnostic fails an unconfirmed recovery: ${text}`, () => {
    assert.equal(recovery.workerResumeStatus({ exitCode: null, screen: { text: () => text } }), "resume failed");
    assert.equal(recovery.workerResumeStatus({ exitCode: null, screen: { text: () => `The fixture printed: ${text}` } }), "pending");
  });
}

test("a failed claim release stays claimed in memory and on disk", (t) => {
  const row = record();
  const f = fixture(t, [row]);
  assert.equal(f.runs.claim(row.id), true);
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("disk unavailable"); });
  assert.equal(f.runs.releaseClaim(row.id), false);
  assert.equal(f.runs.claim(row.id), false);
  rename.mock.restore();
  assert.equal(createPaneRuns(f.file).claim(row.id), false);
  assert.equal(f.runs.releaseClaim(row.id), true);
  assert.equal(createPaneRuns(f.file).claim(row.id), true);
});

test("a successful replacement keeps its claim", (t) => {
  const row = record();
  const f = fixture(t, [row]);
  assert.equal(f.runs.claim(row.id), true);
  f.runs.started({ ...row, id: randomUUID(), session: { ...row.session, recoveredFrom: row.id } });
  assert.equal(f.runs.releaseClaim(row.id), false);
  assert.equal(f.runs.claim(row.id), false);
});

for (const failure of ["launch", "start", "hold"]) {
  test(`${failure} releases a claimed recovery durably before retry`, async (t) => {
    const row = record();
    const f = fixture(t, [row]);
    const owner = { id: 1, isDestroyed: () => false, send() {} };
    let launches = 0;
    const host = createTerminalHost({ authorize() {}, owner: () => owner, resolveCwd: async () => ROOT,
      paneRuns: f.runs, platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 8 * 1024 ** 3,
      workerLaunch: async () => {
        launches++;
        assert.ok(JSON.parse(fs.readFileSync(f.file, "utf8"))[0].recovery?.claimedAt);
        if (failure === "launch") throw new Error("launch failed");
        if (failure === "hold") return { kind: "hold", hold: "usage low" };
        return { kind: "managed", executable: "codex", args: [], environment: {}, account: { id: "codex", generation: 0 } };
      },
      loadPty: () => ({ spawn() { throw new Error("start failed"); } }),
    });
    t.after(() => host.dispose());
    for (let attempt = 0; attempt < 2; attempt++) {
      const opening = host.openForBot("bot", { cwd: ROOT, command: "codex" }, row);
      if (failure === "hold") assert.deepEqual(await opening, { hold: "usage low" });
      else await assert.rejects(opening, new RegExp(`${failure} failed`));
      assert.equal(f.runs.restarted().get("bot")[0].recovery, undefined);
      assert.equal(createPaneRuns(f.file).restarted().get("bot")[0].recovery, undefined);
    }
    assert.equal(launches, 2);
  });
}

test("a rejected claim never calls worker launch or releases another claim", async (t) => {
  const row = record();
  const f = fixture(t, [row]);
  assert.equal(f.runs.claim(row.id), true);
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  let launches = 0;
  const host = createTerminalHost({ authorize() {}, owner: () => owner, resolveCwd: async () => ROOT,
    paneRuns: f.runs, platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 8 * 1024 ** 3,
    workerLaunch: async () => { launches++; throw new Error("must not launch"); },
  });
  t.after(() => host.dispose());
  await assert.rejects(host.openForBot("bot", { cwd: ROOT, command: "codex" }, row), /claimed/);
  assert.equal(launches, 0);
  assert.ok(f.runs.restarted().get("bot")[0].recovery);
});

test("zero-account recovery claims its run and resumes it in the same unrouted pane", async (t) => {
  assert.ok(recovery);
  const row = record("claude");
  row.session.unrouted = true;
  const f = fixture(t, [row]);
  const children = [];
  const inputs = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  const host = createTerminalHost({ authorize() {}, owner: () => owner, resolveCwd: async () => ROOT, workerAccountsEnabled: false,
    paneRuns: f.runs, platform: "win32", env: { PATH: "C:/fixture/bin", CLAUDE_CONFIG_DIR: "C:/fixture/claude" }, freeMemory: () => 8 * 1024 ** 3, setPriority() {},
    mailbox: async () => ({ url: "http://127.0.0.1:9", token: "fresh", binDir: "C:/bin" }),
    workerLaunch: async (input) => {
      inputs.push(input);
      return { kind: "unrouted", executable: "claude", args: ["--model", "fixture", "-r", row.session.nativeId, NUDGE], workerSettings: true, account: { id: "claude", generation: 0 },
        session: { engine: "claude", nativeId: row.session.nativeId, launchGeneration: randomUUID(), template: row.session.template } };
    },
    loadPty: () => ({ spawn(_shell, args, options) {
      const child = { args, options, writes: [], onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write(text) { this.writes.push(text); }, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
  });
  t.after(() => host.dispose());
  const pane = await host.openForBot(row.botId, { label: row.label, cwd: ROOT, command: "claude" }, row);
  assert.equal(inputs[0].resume.unrouted, true);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).find((run) => run.id === row.id).recovery.replacement, pane.sessionId);
  assert.equal(children[0].args.includes("-NoProfile"), false);
  assert.equal(children[0].options.env.CLAUDE_CONFIG_DIR, "C:/fixture/claude");
  assert.equal(children[0].writes[0], `& 'claude' '--model' 'fixture' '-r' '${row.session.nativeId}' '${NUDGE}' '--settings' '${path.join("C:/bin", "claude-worker.json")}'\r`);
  const env = children[0].options.env;
  assert.equal(host.captureWorkerSession(`Bearer ${env.ORBIT_SESSION_AUTH}`, { pane: pane.sessionId, launchGeneration: env.ORBIT_SESSION_GENERATION,
    session_id: row.session.nativeId, cwd: ROOT, transcript_path: null, source: "resume" }), true);
  assert.equal(host.workerResumeStatus(pane.sessionId), "resumed");
  const resumed = JSON.parse(fs.readFileSync(f.file, "utf8")).find((run) => run.id === pane.sessionId);
  assert.deepEqual([resumed.session.unrouted, resumed.session.recoveredFrom, resumed.session.source], [true, row.id, "resume"]);
  await assert.rejects(host.openForBot(row.botId, { cwd: ROOT, command: "claude" }, row), /claimed/);
  assert.equal(children.length, 1);
});

test("managed recovery preserves teacher and binds a new pane, generation and fresh grant", async (t) => {
  assert.ok(recovery);
  const row = record("claude");
  const f = fixture(t, [row]);
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  const host = createTerminalHost({ authorize() {}, owner: () => owner, resolveCwd: async () => ROOT,
    paneRuns: f.runs, platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 8 * 1024 ** 3, setPriority() {},
    mailbox: async () => ({ url: "http://127.0.0.1:9", token: "fresh" }),
    workerLaunch: async (input) => {
      assert.equal(input.resume.nativeId, row.session.nativeId);
      return { kind: "managed", executable: "claude", args: ["-r", row.session.nativeId, NUDGE], environment: {}, account: { id: "claude", generation: 0 },
        session: { engine: "claude", nativeId: row.session.nativeId, launchGeneration: randomUUID(), template: row.session.template } };
    },
    loadPty: () => ({ spawn(_shell, _args, options) {
      const child = { options, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
  });
  t.after(() => host.dispose());
  const pane = await host.openForBot(row.botId, { label: row.label, cwd: ROOT, command: "claude" }, row);
  assert.notEqual(pane.sessionId, row.id);
  assert.equal(children[0].options.env.ORBIT_TEACHER, "teacher");
  assert.equal(host.workerResumeStatus(pane.sessionId), "pending");
  const env = children[0].options.env;
  assert.equal(host.captureWorkerSession(`Bearer ${env.ORBIT_SESSION_AUTH}`, { pane: pane.sessionId, launchGeneration: env.ORBIT_SESSION_GENERATION,
    session_id: row.session.nativeId, cwd: ROOT, transcript_path: null, source: "resume" }), true);
  assert.equal(host.workerResumeStatus(pane.sessionId), "resumed");
  children[0].data("Error: No conversation found with session ID");
  assert.equal(host.workerResumeStatus(pane.sessionId), "resumed");
  await assert.rejects(host.openForBot(row.botId, { cwd: ROOT, command: "claude" }, row), /claimed/);
  assert.equal(children.length, 1);
});

test("recovered workers the memory gate refuses are tried 3 times, then listed to their bot", async (t) => {
  assert.ok(recovery);
  const rows = Array.from({ length: 16 }, (_, index) => record("claude", { label: `W${index + 1}` }));
  const f = fixture(t, rows);
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  let clock = 0;
  let opens = 0;
  // The reading lags: no resumed worker has loaded yet, so it stays at 6 GB.
  const host = createTerminalHost({ authorize() {}, owner: () => owner, resolveCwd: async () => ROOT, now: () => clock,
    paneRuns: f.runs, platform: "linux", env: { SHELL: "/bin/sh" }, freeMemory: () => 6 * 1024 ** 3, setPriority() {},
    mailbox: async () => ({ url: "http://127.0.0.1:9", token: "fresh" }),
    workerLaunch: async (input) => ({ kind: "managed", executable: "claude", args: ["-r", input.resume.nativeId, NUDGE], environment: {}, account: { id: "claude", generation: 0 },
      session: { engine: "claude", nativeId: input.resume.nativeId, launchGeneration: randomUUID(), template: input.resume.template } }),
    loadPty: () => ({ spawn() {
      const child = { onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
  });
  t.after(() => host.dispose());
  await recovery.recoverWorkers({ ...f.options, wait: async (ms) => { f.waits.push(ms); clock += ms; },
    host: { openForBot: (...args) => { opens += 1; return host.openForBot(...args); }, workerResumeStatus: () => "resumed", closeForBot: (...args) => host.closeForBot(...args) } });
  assert.equal(children.length, 10);
  assert.equal(opens, 10 + 6 * 3);
  assert.equal(f.waits.filter((ms) => ms === 2000).length, opens - 1);
  assert.equal(f.notes.length, 1);
  const [resumed, ...restarted] = f.notes[0].text.split("\n");
  assert.equal(resumed, `RESUMED: ${rows.slice(0, 10).map((row) => `${row.label} (claude)`).join(", ")}.`);
  assert.match(restarted[0], /^RESTARTED: Wink restarted, so these panes you spawned closed mid-run:$/);
  assert.deepEqual(restarted.slice(1, 7).map((line) => line.split(" [pane ")[0]), rows.slice(10).map((row) => `- ${row.label} (resume failed)`));
  assert.match(restarted.at(-1), /Spawn a FRESH worker to continue, or tell the user\.$/);
  assert.equal(f.runs.restarted().size, 0);
});
