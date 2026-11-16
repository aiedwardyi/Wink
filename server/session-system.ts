import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ResumeSeed } from "./turn-context.ts";

// One file per resume cursor, so bots.json never carries a prompt copy.
export const SESSION_SYSTEM_DIR = join(DATA_DIR, "session-system");
export const sessionSystemFile = (instanceId: string, cursor: ResumeSeed["cursor"]) =>
  `${createHash("sha256").update(`${instanceId}\n${JSON.stringify(cursor)}`).digest("hex").slice(0, 32)}.txt`;

export function readSessionSystem(instanceId: string, cursor: ResumeSeed["cursor"]): string | undefined {
  try {
    return readFileSync(join(SESSION_SYSTEM_DIR, sessionSystemFile(instanceId, cursor)), "utf8");
  } catch {
    return undefined;
  }
}

export function writeSessionSystem(instanceId: string, cursor: ResumeSeed["cursor"], text: string) {
  mkdirSync(SESSION_SYSTEM_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(SESSION_SYSTEM_DIR, sessionSystemFile(instanceId, cursor)), text, { mode: 0o600 });
}

export function dropSessionSystem(instanceId: string, cursor: ResumeSeed["cursor"]) {
  rmSync(join(SESSION_SYSTEM_DIR, sessionSystemFile(instanceId, cursor)), { force: true });
}
