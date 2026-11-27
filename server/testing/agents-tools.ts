// The agents proxy's real tools/list, launched with the env an engine handed
// it, and the schema chars an engine re-sends on every model call.
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { spawnTestNode } from "./harness-auth.ts";

export type ListedTool = { name: string; description: string; inputSchema: object; _meta?: { "anthropic/alwaysLoad"?: boolean } };

export const AGENTS_PROXY = fileURLToPath(new URL("../drivers/agents-proxy.ts", import.meta.url));
export const AGENTS_IDENTITY = { OMB_HARNESS_URL: "http://127.0.0.1:1", OMB_BOT_ID: "b1", OMB_THREAD_ID: "t-agents-budget", OMB_COMMS_TOKEN: "tok", OMB_TURN_DEPTH: "0" };
/** The tools behind find_wink_tool (tool-catalog.ts OPTIONAL). */
export const CATALOG_ONLY = ["web_read", "board_search", "board_post", "create_bot", "create_channel", "generate_image", "call_api", "request_credential", "usage_status", "wake_me", "link_room_fix", "post_to_group"];

/** Only the proxy's OMB_* settings cross over: the rest is the test's own profile. */
export async function listAgentsTools(engineEnv: Record<string, string | undefined>): Promise<ListedTool[]> {
  const own = Object.fromEntries(Object.entries(engineEnv).filter(([key]) => key.startsWith("OMB_")));
  const child = spawnTestNode(process.execPath, [AGENTS_PROXY], { env: { ...process.env, ...own }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const listed = new Promise<ListedTool[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agents proxy never answered tools/list")), 10_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n").find((row) => row.includes('"id":2,'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line).result.tools);
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  try {
    return await listed;
  } finally {
    child.kill();
  }
}

export function schemaChars(tools: readonly ListedTool[]): number {
  return JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))).length;
}

/** Every call re-sends these; catalog tools wait behind find_wink_tool. */
export function expectAgentsBudget(engine: string, tools: readonly ListedTool[], budget: number) {
  const names = tools.map((tool) => tool.name);
  expect(names.filter((name) => CATALOG_ONLY.includes(name))).toEqual([]);
  expect(names).toEqual(expect.arrayContaining(["find_wink_tool", "call_wink_tool"]));
  const chars = schemaChars(tools);
  expect(chars, `${engine} re-reads ${chars} chars of agents tool schemas on every call. Move a rarely used tool behind the catalog (tool-catalog.ts OPTIONAL) or shorten a description; raise this budget only with measured token numbers.`).toBeLessThanOrEqual(budget);
}
