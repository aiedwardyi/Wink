import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const path = join(DATA_DIR, "grok-agents-allow.json");
let saved: Record<string, string> | undefined;
const keyOf = (configPath: string) => process.platform === "win32" ? configPath.toLowerCase() : configPath;

function state(): Record<string, string> {
  if (saved) return saved;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => typeof v !== "string")) throw new Error("invalid allow state");
    saved = Object.assign(Object.create(null), value);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    saved = Object.create(null) as Record<string, string>;
  }
  return saved!;
}

export function grokAgentsAllowState(configPath: string): string | undefined {
  return state()[keyOf(configPath)];
}

export function saveGrokAgentsAllowState(configPath: string, result: string): void {
  const next = { ...state(), [keyOf(configPath)]: result };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  saved = next;
}
