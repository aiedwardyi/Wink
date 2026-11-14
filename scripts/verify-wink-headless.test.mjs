import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIRS = [".claude/skills/verify-wink", "scripts", "tools"];
const LAUNCH = /\.(launch|launchServer|launchPersistentContext)\(([^)]*)/g;

function sources() {
  return DIRS.flatMap((dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(mjs|cjs|js|ts)$/.test(entry.name) && !/\.(node-)?test\./.test(entry.name) && !entry.parentPath.includes("node_modules"))
    .map((entry) => join(entry.parentPath, entry.name)));
}

describe("worker test browsers", () => {
  // A headed window, even off-screen, takes the user's keyboard focus on Windows.
  it("launch headless", () => {
    const launches = sources().flatMap((file) => [...readFileSync(file, "utf8").matchAll(LAUNCH)]
      .filter((match) => /playwright|chromium|firefox|webkit|\[engine\]/.test(readFileSync(file, "utf8").slice(Math.max(0, match.index - 80), match.index)))
      .map((match) => ({ file, options: match[2] ?? "" })));
    expect(launches.length).toBeGreaterThan(0);
    for (const { file, options } of launches) expect({ file, headless: /headless:\s*true/.test(options) }).toEqual({ file, headless: true });
  });
});
