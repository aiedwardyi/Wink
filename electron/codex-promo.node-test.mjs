import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTerminalHost } from "./terminal-host.mjs";

const CODE = "codex_byok_restricted_by_api_credit_promo";
const MESSAGE = "This OpenAI key's org is on API credit, which Codex can't use. Pick another Codex account.";

for (const [label, text, marked] of [
  ["error", `■ Request failed: ${CODE}`, true],
  ["wrapped error", `■ Request failed: ${"x".repeat(65)} ${CODE}`, true],
  ["grep", `123: const code = '${CODE}'`, false],
  ["quoted error", `+ ■ Request failed: ${CODE}`, false],
]) {
  test(`the worker watcher handles promo ${label}`, async (t) => {
    const home = fs.mkdtempSync(path.join(process.env.ORBIT_SCRATCH || os.tmpdir(), "promo-worker-"));
    let clock = 1000;
    const notes = [];
    const owner = { id: 1, isDestroyed: () => false, send() {} };
    const child = { writes: [], onData(cb) { this.data = cb; }, onExit() {}, write(value) { this.writes.push(value); }, resize() {}, kill() {} };
    const host = createTerminalHost({
      authorize() {}, owner: () => owner, resolveCwd: async () => home, platform: "linux",
      env: { SHELL: "/bin/sh" }, loadPty: () => ({ spawn: () => child }),
      now: () => clock, freeMemory: () => 8 * 1024 ** 3, setPriority() {}, stallCheckMs: 5,
      mailbox: async () => ({ url: "http://127.0.0.1:9", token: "secret" }),
      notePane: async (_mail, _scope, text) => { notes.push(text); },
      workerLaunch: async () => ({ kind: "managed", executable: "codex", args: [],
        account: { id: "codex-credit", generation: 1 }, environment: { CODEX_HOME: home } }),
    });
    t.after(() => host.dispose());
    await host.openForBot("bot-1", { label: "promo", command: "codex", cols: 80, rows: 24 });
    child.data(`${child.writes[0]}\r\n${text}\r\n› `);
    await new Promise((resolve) => setTimeout(resolve, 25));
    clock += 120_001;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fs.existsSync(path.join(home, ".wink-codex-promo.json")), marked);
    if (marked) {
      assert.deepEqual(notes, [MESSAGE]);
      clock += 120_001;
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(notes, [MESSAGE]);
    }
  });
}
