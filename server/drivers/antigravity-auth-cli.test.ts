import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterAll, describe, expect, it } from "vitest";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { runTestNode, spawnTestNode } from "../testing/harness-auth.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-agy-auth-cli-"));
const calls = join(dir, "calls.txt");
const fake = join(dir, "fake-agy.cjs");
writeFileSync(fake, `
const fs = require("node:fs");
if (process.argv.includes("--login")) {
  fs.appendFileSync(process.env.FAKE_AGY_CALLS, "terminal-login " + (process.env.SSH_CONNECTION || "-") + "\\n");
  process.stdout.write("Open this link in a browser to log in with Google:\\n  https://accounts.google.com/o/oauth2/auth?x=1\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\\n");
  process.stdin.once("data", (code) => { fs.appendFileSync(process.env.FAKE_AGY_CALLS, "code " + code.toString().trim() + "\\n"); process.exit(code.toString().startsWith("good") ? 0 : 1); });
} else require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  fs.appendFileSync(process.env.FAKE_AGY_CALLS, method + "\\n");
  const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
  if (process.env.FAKE_AGY_REFUSE === method) return reply({ error: { code: -32000, message: "refused" } });
  if (method === "authenticate") process.stdout.write(JSON.stringify({ method: "session/update", params: { text: "Open https://accounts.google.com/o/oauth2/auth?x=1 to sign in" } }) + "\\n");
  reply({ result: {} });
});
`);

// agy 1.3.0 has no ACP server: it answers `agy acp` with the recorded stderr and exit code.
const noAcp = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/antigravity/acp-unsupported.json", import.meta.url), "utf8")).reply;
const oldAgy = join(dir, "agy-1.3.0.cjs");
writeFileSync(oldAgy, `
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_AGY_CALLS, process.argv.slice(2).join(" ") + "\\n");
process.stderr.write(${JSON.stringify(noAcp.stderr)}, () => process.exit(${noAcp.exitCode}));
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

  it("says why an agy older than 1.5 cannot sign in or out, instead of only that it closed", async () => {
    for (const mode of ["login", "logout"]) {
      const result = await run(mode, { OMB_AGY_CLI: `"${process.execPath}" "${oldAgy}"` });
      expect(result.status).toBe(1);
      expect(result.calls).toEqual(["acp"]);
      expect(result.stderr).toContain("agy is older than 1.5 and has no ACP server");
    }
  });

  it.runIf(process.platform === "win32")("signs an agy older than 1.5 out by deleting its saved sign-in", async () => {
    // A throwaway Credential Manager entry stands in for agy's gemini:antigravity.
    const target = `omb-test-${randomUUID()}:antigravity`;
    const listed = () => execFileSync("cmdkey.exe", ["/list"], { encoding: "utf8", windowsHide: true }).includes(`target=${target}`);
    execFileSync("cmdkey.exe", [`/generic:${target}`, "/user:antigravity", "/pass:not-a-token"], { windowsHide: true });
    try {
      expect(listed()).toBe(true);
      const result = await run("logout", { OMB_AGY_CLI: `"${process.execPath}" "${oldAgy}"`, OMB_AGY_KEYRING: target });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["acp"]);
      expect(listed()).toBe(false);
    } finally {
      try { execFileSync("cmdkey.exe", [`/delete:${target}`], { stdio: "ignore", windowsHide: true }); } catch {}
    }
  });

  it("logs out over ACP, not through the keyring, when agy has an ACP server", async () => {
    const result = await run("logout", { OMB_AGY_KEYRING: "omb-test-absent:antigravity" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(["initialize", "logout"]);
  });

  it("fails when agy cannot start", async () => {
    const result = await run("logout", { OMB_AGY_CLI: join(dir, "no-such-agy") });
    expect(result.status).toBe(1);
  });

  it.each([["good-code", 0], ["bad-code", 1]] as const)("hands a pasted %s to agy's terminal login", async (code, status) => {
    writeFileSync(calls, "");
    const child = spawnTestNode(process.execPath, [SPAWNED_PROXIES.antigravityAuth, "login", "--paste"], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OMB_AGY_CLI: `"${process.execPath}" "${fake}"`, FAKE_AGY_CALLS: calls, SSH_CONNECTION: "ssh" },
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const prompted = stdout.includes("press Enter:");
      stdout += chunk;
      if (!prompted && stdout.includes("press Enter:")) child.stdin.write(`${code}\n`);
    });
    const [exit] = await once(child, "close");
    expect(exit).toBe(status);
    expect(stdout).toContain("https://accounts.google.com/o/oauth2/auth?x=1");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["terminal-login ssh", `code ${code}`]);
  });

  it("refuses an unknown mode", async () => {
    expect((await run("whoami")).status).toBe(2);
  });
});
