import { appendFileSync, renameSync, statSync } from "node:fs";

export const LOG_MAX_BYTES = 256 * 1024 * 1024;

export function appendRotatingLog(file: string, text: string, maxBytes = LOG_MAX_BYTES): void {
  try {
    if (statSync(file).size >= maxBytes) renameSync(file, `${file}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  appendFileSync(file, text, { mode: 0o600 });
}
