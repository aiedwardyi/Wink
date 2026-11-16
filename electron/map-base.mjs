import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function mapBase(cwd) {
  let folder = resolve(cwd);
  while (!existsSync(join(folder, ".git"))) {
    const parent = dirname(folder);
    if (parent === folder) return Promise.resolve(null);
    folder = parent;
  }
  return new Promise(resolve => {
    execFile("git", ["-C", cwd, "rev-parse", "HEAD"], { windowsHide: true, timeout: 3_000, maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      const head = stdout?.trim();
      resolve(!error && /^[a-f0-9]{40,64}$/.test(head) ? head : null);
    });
  });
}
