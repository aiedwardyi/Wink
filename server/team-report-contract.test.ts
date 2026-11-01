import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.env.TEAM_REPORT_CONTRACT_ROOT ?? process.cwd();

describe("team report integration contract", () => {
  it("preserves the authenticated reporting owner in the relay ready frame", async () => {
    const { readyMessageSchema } = await import(pathToFileURL(join(root, "shared/relay-protocol.ts")).href);
    const owner = "a".repeat(64);
    expect(readyMessageSchema.parse({ type: "ready", session: "s", poolToken: "p", pool: { min: 0, max: 1 }, reportOwner: owner }).reportOwner).toBe(owner);
  });

  it("advertises a flat reporting tool to an eligible existing bot", async () => {
    const result = await new Promise<{ result: { tools: Array<{ name: string; inputSchema: unknown }> } }>((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:OMB_|ORBIT_)/.test(key)));
      const child = spawn(process.execPath, [join(root, "server/drivers/agents-proxy.ts")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...env, OMB_BOT_ID: "existing-bot", OMB_THREAD_ID: "existing-thread", OMB_COMMS_TOKEN: "fixture", OMB_TEAM_REPORTS: "1" } });
      let text = "", error = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("proxy timed out")); }, 5000);
      child.stderr.on("data", (chunk) => { error += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => { clearTimeout(timer); if (code) reject(new Error(error)); });
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (!text.includes("\n")) return;
        clearTimeout(timer); child.stdin.end(); resolve(JSON.parse(text.split("\n")[0]!));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    });
    const tool = result.result.tools.find((tool) => tool.name === "report_issue");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool!.inputSchema)).not.toMatch(/"(?:oneOf|anyOf|allOf|const|format)"/);
  });
});
