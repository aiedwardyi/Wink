import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function linkedGitDirs(root: string) {
  try {
    const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"))?.[1].trim();
    if (!link) return null;
    const own = resolve(root, link);
    const common = resolve(own, readFileSync(join(own, "commondir"), "utf8").trim());
    return { own, common };
  } catch { return null; }
}
