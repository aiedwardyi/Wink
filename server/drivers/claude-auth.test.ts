// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { execCli } from "../procs.ts";
import { createTempDirs } from "../testing/cleanup.ts";
import { claudeAuthStatus, claudeSignedIn } from "./claude.ts";

const temp = createTempDirs();
afterEach(() => temp.remove());

describe("claudeSignedIn", () => {
  it("uses the CLI's machine-readable auth status", async () => {
    const run = ((cli, args, options, callback) => {
      expect(cli).toBe("claude-custom");
      expect(args).toEqual(["auth", "status", "--json"]);
      expect(options).toMatchObject({ env: { PATH: "/custom/bin" } });
      expect(options).not.toHaveProperty("timeout");
      callback(null, '{"loggedIn":true}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude-custom", { PATH: "/custom/bin" }, run)).toBe(true);
  });

  it("uses loggedIn:false even though the real CLI exits with code 1", async () => {
    const run = ((_cli, _args, _options, callback) => {
      callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
  });

  it("leaves sign-in unknown when the command has no valid status", async () => {
    const failed = ((_cli, _args, _options, callback) => {
      callback(new Error("auth status unavailable"), "");
    }) satisfies typeof import("../procs.ts").execCli;
    const malformed = ((_cli, _args, _options, callback) => {
      callback(null, "not json");
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, failed)).toBeUndefined();
    expect(await claudeSignedIn("claude", {}, malformed)).toBeUndefined();
  });
});

describe("claudeAuthStatus deadline", () => {
  it("stops waiting at its deadline but never kills a token renewal", { timeout: 30_000 }, async () => {
    const dir = temp.make(join(tmpdir(), "claude-auth-"));
    const script = join(dir, "claude.cjs");
    const runs = join(dir, "runs");
    const credentials = join(dir, ".credentials.json");
    writeFileSync(script, `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(runs)}, '.');
      if (fs.readFileSync(${JSON.stringify(runs)}, 'utf8').length > 1) process.stdout.write('{"loggedIn":true}');
      else setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(credentials)}, '{"rotated":true}');
        process.stdout.write('{"loggedIn":true}');
      }, 3500);
    `);
    const cli = `"${process.execPath}" "${script}"`;
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    const status = (deadline: number) => claudeAuthStatus(cli, env, execCli, undefined, deadline);

    const started = Date.now();
    expect(await status(200)).toEqual({});
    const waited = Date.now() - started;
    const again = status(200);
    await vi.waitFor(() => expect(existsSync(credentials)).toBe(true), { timeout: 10_000, interval: 50 });
    expect(await again).toEqual({});
    expect(readFileSync(runs, "utf8")).toBe(".");
    expect(waited).toBeLessThan(2000);
    await vi.waitFor(async () => {
      expect(await status(5000)).toMatchObject({ signedIn: true });
      expect(readFileSync(runs, "utf8").length).toBeGreaterThan(1);
    }, { timeout: 10_000 });
  });
});
