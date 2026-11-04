import { existsSync, readFileSync } from "node:fs";
import { constants, getPriority, setPriority } from "node:os";

const lock = "C:/Users/mredw/Desktop/Orbit-extras/Orbit-cards/HEAVY.lock";

export function checkGate() {
  if (existsSync(lock) && /\b(?:GO-|PERF-|SPEED-)|\bgate\b/i.test(readFileSync(lock, "utf8"))) {
    throw new Error("Timing gate active; fixture work held");
  }
}

export function lowerPriority(pid = 0) {
  setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  return { pid: pid || process.pid, priority: getPriority(pid), name: "BelowNormal" };
}
