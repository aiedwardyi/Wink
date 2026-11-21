import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { runTestNode } from "../testing/harness-auth.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-agy-auth-cli-"));
const calls = join(dir, "calls.txt");
const fake = join(dir, "fake-agy.cjs");
writeFileSync(fake, `
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  fs.appendFileSync(process.env.FAKE_AGY_CALLS, method + "\\n");
  const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
  if (process.env.FAKE_AGY_REFUSE === method) return reply({ error: { code: -32000, message: "refused" } });
  if (method === "authenticate") process.stdout.write(JSON.stringify({ method: "session/update", params: { text: "Open https://accounts.google.com/o/oauth2/auth?x=1 to sign in" } }) + "\\n");
  reply({ result: {} });
});
`);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(mode: string, env: Record<string, string> = {}) {
  writeFileSync(calls, "");
  const result = await runTestNode([SPAWNED_PROXIES.antigravityAuth, mode], {
    timeout: 20_000,
    env: { ...process.env, OMB_AGY_CLI: `"${process.execPath}" "${fake}"`, FAKE_AGY_CALLS: calls, ...env },
  });
  return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
}

describe("agy sign-in helper", () => {
  it("logs in over ACP with the Google method and prints the sign-in link", async () => {
    const result = await run("login");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["initialize", "authenticate"]);
    expect(result.stdout.trim()).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
  });

  it("logs out over ACP", async () => {
    const result = await run("logout");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["initialize", "logout"]);
  });

  it.each(["login", "logout"])("fails %s when agy refuses", async (mode) => {
    const result = await run(mode, { FAKE_AGY_REFUSE: mode === "login" ? "authenticate" : "logout" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refused");
  });

  it("fails when agy cannot start", async () => {
    const result = await run("logout", { OMB_AGY_CLI: join(dir, "no-such-agy") });
    expect(result.status).toBe(1);
  });

  it("refuses an unknown mode", async () => {
    expect((await run("whoami")).status).toBe(2);
  });
});
