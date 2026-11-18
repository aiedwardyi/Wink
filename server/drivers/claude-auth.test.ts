// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { execCli } from "../procs.ts";
import { createTempDirs } from "../testing/cleanup.ts";
import { cachedSignIn } from "./auth-status.ts";
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
  it.each([[3200, 0], [3200, 1000], [3400, 0]])("delivers a %i ms probe after a %i ms setup refresh", async (probeMs, serverMs) => {
    vi.useFakeTimers();
    try {
      const env = { CLAUDE_CONFIG_DIR: `setup-${probeMs}-${serverMs}` };
      let active = 0;
      let peak = 0;
      const run = vi.fn<typeof execCli>((_cli, _args, _options, callback) => {
        peak = Math.max(peak, ++active);
        setTimeout(() => {
          active--;
          callback(null, '{"loggedIn":true,"email":"test@example.com"}');
        }, probeMs);
      });
      const check = cachedSignIn(() => claudeAuthStatus("claude", env, run), (status) => status.signedIn === true);
      const end = Date.now() + 300_000;
      const reads: Awaited<ReturnType<typeof check>>[] = [];
      const setup = async () => {
        while (Date.now() < end) {
          const refresh = reads.length > 0;
          if (refresh) await new Promise((resolve) => setTimeout(resolve, 500 + serverMs));
          const status = await check(refresh);
          reads.push(status);
          if (status.signedIn !== undefined) return;
        }
      };

      const finished = setup();
      await vi.advanceTimersByTimeAsync(305_000);
      await finished;
      expect({ reads: reads.length, status: reads.at(-1), launches: run.mock.calls.length, peak }).toEqual({
        reads: 2, status: { signedIn: true, account: "test@example.com" }, launches: 1, peak: 1,
      });
      expect(reads[0]).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes an expired late answer", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn<typeof execCli>()
        .mockImplementationOnce((_cli, _args, _options, callback) => {
          setTimeout(() => callback(null, '{"loggedIn":true}'), 3200);
        })
        .mockImplementationOnce((_cli, _args, _options, callback) => callback(null, '{"loggedIn":false}'));
      const status = () => claudeAuthStatus("claude", { CLAUDE_CONFIG_DIR: "expired-late-answer" }, run);
      const first = status();
      await vi.advanceTimersByTimeAsync(33_200);
      expect(await first).toEqual({});
      expect(await status()).toMatchObject({ signedIn: false });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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
    expect(await status(5000)).toMatchObject({ signedIn: true });
    expect(readFileSync(runs, "utf8")).toBe(".");
    expect(await status(5000)).toMatchObject({ signedIn: true });
    expect(readFileSync(runs, "utf8")).toBe("..");
  });
});
