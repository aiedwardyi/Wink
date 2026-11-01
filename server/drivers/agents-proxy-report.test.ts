import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const input = vi.hoisted(() => {
  vi.stubEnv("OMB_BOT_ID", "fixture-bot");
  vi.stubEnv("OMB_THREAD_ID", "fixture-thread");
  vi.stubEnv("OMB_COMMS_TOKEN", "fixture-token");
  vi.stubEnv("OMB_HARNESS_URL", "http://127.0.0.1:8799");
  vi.stubEnv("OMB_TEAM_REPORTS", "1");
  return { line: (_line: string) => {} };
});

vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      on: (event: string, listener: (line: string) => void) => { if (event === "line") input.line = listener; },
    }),
  },
}));

import "./agents-proxy.ts";

const { reply } = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/claude/team-report-mcp.json", import.meta.url), "utf8"));

function rpc(frame: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      write.mockRestore();
      resolve(JSON.parse(String(chunk)));
      return true;
    });
    input.line(JSON.stringify(frame));
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); });

describe("recorded team report MCP requests", () => {
  it("accepts the engine handshake and advertises a flat report tool", async () => {
    const init = await rpc(reply.initialize);
    expect(init.id).toBe(reply.initialize.id);
    expect(init.result.protocolVersion).toBe(reply.initialize.params.protocolVersion);
    const list = await rpc(reply.list);
    const tool = list.result.tools.find((tool: { name: string }) => tool.name === "report_issue");
    expect(tool.inputSchema.required).toEqual(["action"]);
    expect(tool.inputSchema.properties.action.enum).toEqual(["collect", "send", "draft", "retry"]);
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(?:oneOf|anyOf|allOf|const|format)"/);
  });

  it("forwards recorded collect arguments with the authenticated turn identity", async () => {
    const draft = { state: "draft", id: "a".repeat(32), sent: false };
    const fetch = vi.fn(async () => new Response(JSON.stringify(draft)));
    vi.stubGlobal("fetch", fetch);
    const result = await rpc(reply.call);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8799/api/internal/team-report", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ authorization: "Bearer fixture-token" }),
    }));
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ...reply.call.params.arguments, fromBotId: "fixture-bot", fromThreadId: "fixture-thread" });
    expect(result).toMatchObject({ id: reply.call.id, result: { isError: false, content: [{ type: "text", text: JSON.stringify(draft) }] } });
  });

  it("returns a report refusal as an MCP tool error", async () => {
    const refusal = { error: "Reporting is not authorized" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refusal))));
    expect(await rpc(reply.call)).toMatchObject({ id: reply.call.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(refusal) }] } });
  });

  it("hides and rejects the recorded call when team reporting is disabled", async () => {
    vi.stubEnv("OMB_TEAM_REPORTS", "0");
    vi.resetModules();
    await import("./agents-proxy.ts");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const list = await rpc(reply.list);
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("report_issue");
    expect(await rpc(reply.call)).toMatchObject({ id: reply.call.id, error: { code: -32602, message: "Unknown tool: report_issue" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
