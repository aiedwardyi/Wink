import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { ThreadId } from "./contracts.ts";
import { taskPlanSidecarPath, type TaskStateOptions } from "./task-state.ts";

/** Plan paths too many to show inline. Not a task packet: it holds no asks, so it skips Store.savePacket. */
export function writeTaskPlanSidecar(threadId: ThreadId, paths: readonly string[], options: TaskStateOptions = {}): string {
  const path = taskPlanSidecarPath(threadId, options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, paths.map((ref) => JSON.stringify(ref)).join("\n") + "\n", { mode: 0o600 });
  // the bot opens this from the task's cwd, not the server's
  return resolve(path);
}
