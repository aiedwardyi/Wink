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
// The text a session launched with, never updated: a cold resume relaunches with it so the cached prefix holds.
export const sessionStartFile = (instanceId: string, cursor: ResumeSeed["cursor"]) =>
  sessionSystemFile(instanceId, cursor).replace(/\.txt$/, ".start.txt");

const read = (name: string) => {
  try {
    return readFileSync(join(SESSION_SYSTEM_DIR, name), "utf8");
  } catch {
    return undefined;
  }
};

const save = (name: string, text: string) => {
  mkdirSync(SESSION_SYSTEM_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(SESSION_SYSTEM_DIR, name), text, { mode: 0o600 });
};

export function readSessionSystem(instanceId: string, cursor: ResumeSeed["cursor"]): string | undefined {
  return read(sessionSystemFile(instanceId, cursor));
}

export function writeSessionSystem(instanceId: string, cursor: ResumeSeed["cursor"], text: string) {
  save(sessionSystemFile(instanceId, cursor), text);
}

export function readSessionStart(instanceId: string, cursor: ResumeSeed["cursor"]): string | undefined {
  return read(sessionStartFile(instanceId, cursor));
}

export function writeSessionStart(instanceId: string, cursor: ResumeSeed["cursor"], text: string) {
  save(sessionStartFile(instanceId, cursor), text);
}

export function dropSessionSystem(instanceId: string, cursor: ResumeSeed["cursor"]) {
  rmSync(join(SESSION_SYSTEM_DIR, sessionSystemFile(instanceId, cursor)), { force: true });
}
