import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("requires both child markers and catches child import failures", () => {
  const scratch = path.join(os.tmpdir(), "wink-lv0-host");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "entry-test-"));
  roots.push(root);
  const entry = path.join(root, "entry.mjs");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.main).toBe("electron/entry.mjs");
  fs.copyFileSync(new URL("./entry.mjs", import.meta.url), entry);
  fs.writeFileSync(path.join(root, "main.mjs"), 'process.stdout.write("main");');
  fs.writeFileSync(path.join(root, "verify-child.mjs"), 'process.stdout.write("child");');
  const nonce = "a".repeat(48);
  for (const [args, marker, expected] of [[[], "", "main"], [["--orbit-verify-child"], "", "main"], [[], nonce, "main"], [["--orbit-verify-child"], "bad", "main"], [["--orbit-verify-child"], nonce, "child"]]) {
    const run = spawnSync(process.execPath, [entry, ...args], { env: { ...process.env, ORBIT_VERIFY_CHILD: marker }, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(expected);
  }
  fs.writeFileSync(path.join(root, "verify-child.mjs"), 'throw new Error("fixture");');
  expect(spawnSync(process.execPath, [entry, "--orbit-verify-child"], { env: { ...process.env, ORBIT_VERIFY_CHILD: nonce } }).status).toBe(70);
});
