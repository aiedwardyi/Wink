import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isNetworkPath } from "./bot-cwd.ts";
import type { MapPaneRecord } from "./map-pane.ts";
import type { BotRecord, Message } from "./store.ts";

const ROWS = 4;

/** The git folders the bot's own turns wrote files in, newest first, as Map rows labeled with the bot's name. */
export function mapBotSelf(messages: readonly Message[], bot: Pick<BotRecord, "name" | "cwd" | "lastProjectCwd">): MapPaneRecord[] {
  const folders = new Map<string, Set<string>>();
  const seen = new Map<string, string | null>();
  const rootOf = (start: string) => {
    const walked: string[] = [];
    let root: string | null = null;
    for (let dir = start; ; dir = dirname(dir)) {
      const known = seen.get(dir);
      if (known !== undefined) { root = known; break; }
      walked.push(dir);
      // A worktree's .git is a file: either form marks the folder's top.
      if (existsSync(join(dir, ".git"))) { root = dir; break; }
      if (dirname(dir) === dir) break;
    }
    for (const dir of walked) seen.set(dir, root);
    return root;
  };
  const home = bot.cwd ?? bot.lastProjectCwd;
  for (let i = messages.length - 1; i >= 0; i--) {
    const writes = messages[i].kind === "activity" ? messages[i].tool?.writes : undefined;
    for (const path of writes ?? []) {
      if (!isAbsolute(path) && !home) continue;
      const file = resolve(home ?? "", path);
      if (isNetworkPath(file)) continue;
      const root = rootOf(dirname(file));
      if (!root || (!folders.has(root) && folders.size === ROWS)) continue;
      folders.set(root, (folders.get(root) ?? new Set()).add(relative(root, file).replaceAll("\\", "/")));
    }
  }
  return [...folders].map(([root, files]) => ({
    sessionId: `self-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`, cwd: root, label: bot.name, self: [...files],
  }));
}
