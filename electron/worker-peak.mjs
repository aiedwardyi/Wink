import fs from "node:fs";
import path from "node:path";

/** The most ledger panes open at one moment; a still-open pane counts until now. */
export function ledgerPeak(entries, now = Date.now()) {
  const edges = entries
    .filter((entry) => Number.isFinite(entry?.openedAt))
    .flatMap((entry) => [[entry.openedAt, 1], [Number.isFinite(entry.closedAt) ? entry.closedAt : now, -1]])
    // A close and an open at the same moment are a handoff, not two panes.
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  for (const [, step] of edges) peak = Math.max(peak, (live += step));
  return peak;
}

function readPeak(file) {
  try {
    const { count } = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/** Most worker panes open at once, all time; seeded once from the ledger so it does not start at zero. */
export function createWorkerPeak(file, entries, now = Date.now, warn = () => {}) {
  const write = (count) => {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ count }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      warn(error);
    }
  };
  if (readPeak(file) === null) write(ledgerPeak(entries, now()));
  return {
    live(count) {
      // Re-read: another Wink on the same data folder may have raised it.
      if (count > (readPeak(file) ?? 0)) write(count);
    },
  };
}
