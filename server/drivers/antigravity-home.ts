import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { removeWorkspaceDir } from "../workspace.ts";

const MCP_CONFIG = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

/** agy home for note helpers, all Wink's own: agy signs in from the OS keyring, so nothing of ~/.gemini is linked or copied in and a helper's writes stay here. */
export function antigravityHelperHome(env: Record<string, string | undefined>, dataDir = DATA_DIR): string {
  // Older helper homes junctioned the real ~/.gemini; a recursive rm under Electron would empty it.
  removeWorkspaceDir(join(dataDir, "agy-helper"));
  const source = join(env.HOME || env.USERPROFILE || homedir(), ".gemini");
  const home = join(dataDir, "agy-home", createHash("sha256").update(source).digest("hex").slice(0, 16));
  const config = join(home, ".gemini", "config", "mcp_config.json");
  let current: string | undefined;
  try {
    current = readFileSync(config, "utf8");
  } catch {}
  if (current !== MCP_CONFIG) {
    mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
    writeFileAtomic(config, MCP_CONFIG, { mode: 0o600 });
  }
  return home;
}
