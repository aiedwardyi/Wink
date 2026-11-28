import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { antigravityCredentialStore } from "./antigravity-auth.ts";
import { removeWorkspaceDir } from "../workspace.ts";

const MCP_CONFIG = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

const helperHome = (env: Record<string, string | undefined>, dataDir: string) =>
  join(dataDir, "agy-home", createHash("sha256").update(join(env.HOME || env.USERPROFILE || homedir(), ".gemini")).digest("hex").slice(0, 16));

/** Deletes the helper home's copy of agy's token file: a sign-out must not leave a working sign-in behind. */
export function dropAntigravityHelperToken(env: Record<string, string | undefined>, dataDir = DATA_DIR): void {
  rmSync(antigravityCredentialStore({ HOME: helperHome(env, dataDir) }).path, { force: true });
}

/** agy home for note helpers, all Wink's own: only agy's sign-in token file is copied in, so a helper's writes stay here. */
export function antigravityHelperHome(env: Record<string, string | undefined>, dataDir = DATA_DIR): string {
  // Older helper homes junctioned the real ~/.gemini; a recursive rm under Electron would empty it.
  removeWorkspaceDir(join(dataDir, "agy-helper"));
  const home = helperHome(env, dataDir);
  const config = join(home, ".gemini", "config", "mcp_config.json");
  let current: string | undefined;
  try {
    current = readFileSync(config, "utf8");
  } catch {}
  if (current !== MCP_CONFIG) {
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    writeFileAtomic(config, MCP_CONFIG, { mode: 0o600 });
  }
  // A keyring sign-in needs nothing here; a phone sign-in lives in the token file.
  const token = antigravityCredentialStore(env);
  const copy = antigravityCredentialStore({ HOME: home }).path;
  if (token.hasFile()) {
    mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
    copyFileSync(token.path, copy);
  } else dropAntigravityHelperToken(env, dataDir);
  return home;
}
