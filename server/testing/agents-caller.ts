import { existsSync, readFileSync, rmSync } from "node:fs";
import { expect } from "vitest";
import { z } from "zod";

type Api = (method: "GET" | "POST" | "PATCH", path: string, body?: object) => Promise<{ status: number; body: unknown }>;

export async function agentsHeaders(api: Api, dumpPath: string, botId: string, threadId: string, groupId?: string) {
  expect((await api("PATCH", `/api/bots/${botId}`, {
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  })).status).toBe(200);
  const path = groupId ? `/api/groups/${groupId}` : `/api/bots/${botId}`;
  rmSync(dumpPath, { force: true });
  expect((await api("POST", `${path}/messages`, { text: "prepare the team" })).status).toBe(202);
  await expect.poll(() => existsSync(dumpPath), { timeout: 5_000 }).toBe(true);
  const dump = z.object({ mcpConfig: z.object({ mcpServers: z.object({ agents: z.object({
    env: z.object({ OMB_BOT_ID: z.literal(botId), OMB_THREAD_ID: z.literal(threadId), OMB_TURN_DEPTH: z.literal("0"), OMB_COMMS_TOKEN: z.string() }),
  }) }) }) }).parse(JSON.parse(readFileSync(dumpPath, "utf8")));
  expect((await api("POST", `${path}/interrupt`)).status).toBe(200);
  if (groupId) await expect.poll(async () => {
    const result = await api("GET", "/api/bots?messages=0");
    const state = z.object({ groups: z.array(z.object({ id: z.string(), working: z.boolean() })) }).parse(result.body);
    return state.groups.find((group) => group.id === groupId)?.working;
  }).toBe(false);
  return { authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN}`, "content-type": "application/json" };
}
