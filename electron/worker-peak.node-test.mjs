import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaneCleanup } from "./pane-cleanup.mjs";
import { createWorkerPeak, ledgerPeak } from "./worker-peak.mjs";

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-peak-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const peakOf = (file) => JSON.parse(fs.readFileSync(file, "utf8")).count;

test("the ledger peak counts panes open at the same moment", () => {
  assert.equal(ledgerPeak([]), 0);
  assert.equal(ledgerPeak([{ openedAt: 1, closedAt: 5 }, { openedAt: 2, closedAt: 3 }, { openedAt: 4, closedAt: 9 }, { openedAt: 6, closedAt: null }], 10), 2);
  assert.equal(ledgerPeak([{ openedAt: 1, closedAt: 5 }, { openedAt: 5, closedAt: 8 }], 10), 1);
  assert.equal(ledgerPeak([{ openedAt: 1, closedAt: null }, { openedAt: 2, closedAt: null }, { openedAt: "x" }], 10), 2);
});

test("the peak seeds once from the ledger and only rises", (t) => {
  const file = path.join(home(t), "worker-peak.json");
  const peak = createWorkerPeak(file, [{ openedAt: 1, closedAt: 5 }, { openedAt: 2, closedAt: 6 }], () => 10);
  assert.equal(peakOf(file), 2);
  peak.live(1);
  assert.equal(peakOf(file), 2);
  peak.live(3);
  assert.equal(peakOf(file), 3);
  createWorkerPeak(file, [], () => 10);
  assert.equal(peakOf(file), 3);
});

test("opening panes raises the peak by this instance's live panes", (t) => {
  const dir = home(t);
  const file = path.join(dir, "data", "worker-peak.json");
  const cleanup = createPaneCleanup({ home: dir, tempRoot: dir, peakFile: file, instance: "app", schedule: () => ({}), cancel: () => {} });
  t.after(() => cleanup.dispose());
  const pane = (id) => ({ id, botId: "bot", label: "A", cwd: dir, tempRoot: dir });
  assert.equal(peakOf(file), 0);
  cleanup.opened(pane("p1"));
  cleanup.opened(pane("p2"));
  assert.equal(peakOf(file), 2);
  cleanup.exited(pane("p1"));
  cleanup.opened(pane("p3"));
  assert.equal(peakOf(file), 2);
  cleanup.opened(pane("p4"));
  assert.equal(peakOf(file), 3);
});
