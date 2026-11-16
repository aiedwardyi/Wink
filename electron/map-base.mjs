import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mapEmptyTree } from "../shared/map-empty-tree.mjs";

export function mapBase(cwd) {
  let folder = resolve(cwd);
  while (!existsSync(join(folder, ".git"))) {
    const parent = dirname(folder);
    if (parent === folder) return Promise.resolve(null);
    folder = parent;
  }
  const git = (...args) => new Promise(resolve => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 3_000, maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
  return git("rev-parse", "HEAD").then(async head => head === null ? mapEmptyTree(await git("rev-parse", "--show-object-format") ?? "") : /^[a-f0-9]{40,64}$/.test(head) ? head : null);
}
