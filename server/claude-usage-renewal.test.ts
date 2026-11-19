import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { readClaudeUsage } from "./claude-usage-probe.ts";
import { DATA_DIR } from "./config.ts";

const FAKE_CLAUDE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");
const payload = { rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 35, resets_at: null }, seven_day: { utilization: 82, resets_at: null },
} };

// An update restart: the access token expired while Wink was closed, so the CLI's first act is redeeming its one-use refresh token.
it.each(["added", "base"])("lets the CLI finish renewing an expired %s login before the usage read ends", async (kind) => {
  const home = join(DATA_DIR, `renewal-${kind}`);
  mkdirSync(home, { recursive: true });
  const credentials = join(home, ".credentials.json");
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "expired", refreshToken: "grant-1", expiresAt: 0 } }));
  writeFileSync(join(home, "usage.json"), JSON.stringify(payload));
  let release!: () => void;
  const ended = new Promise<void>((resolve) => { release = resolve; });
  const grants: string[] = [];
  // The fake token endpoint answers only once the read has ended the CLI's stdin, so a kill lands mid-renewal.
  const server = createServer((request, response) => {
    if (request.url === "/eof") {
      release();
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      grants.push(JSON.parse(body).refresh_token);
      void ended.then(() => response.end(JSON.stringify({ access_token: "renewed", refresh_token: "grant-2" })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env: NodeJS.ProcessEnv = { FAKE_CLAUDE_GET_USAGE: join(home, "usage.json"), FAKE_CLAUDE_RENEW: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  try {
    const read = kind === "base" ? readClaudeUsage(FAKE_CLAUDE_CLI, { ...env, CLAUDE_CONFIG_DIR: home })
      : readClaudeUsage(FAKE_CLAUDE_CLI, env, { id: "acct_renewal", of: "claude", home, generation: 1 });
    expect(await read).toHaveLength(2);
    expect(grants).toEqual(["grant-1"]);
    expect(JSON.parse(readFileSync(credentials, "utf8")).claudeAiOauth).toMatchObject({ accessToken: "renewed", refreshToken: "grant-2" });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
