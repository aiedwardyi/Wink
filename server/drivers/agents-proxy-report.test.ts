import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("OMB_BOT_ID", "fixture-bot");
  vi.stubEnv("OMB_THREAD_ID", "fixture-thread");
  vi.stubEnv("OMB_COMMS_TOKEN", "fixture-token");
  vi.stubEnv("OMB_HARNESS_URL", "http://127.0.0.1:8799");
  vi.stubEnv("OMB_TEAM_REPORTS", "1");
  vi.stubEnv("OMB_TURN_DEPTH", "0");
});

import { handle as handleRequest } from "./agents-proxy.ts";

const { reply } = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/claude/team-report-mcp.json", import.meta.url), "utf8"));
const { reply: delegation } = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/claude/check-delegation.json", import.meta.url), "utf8"));

function rpc(frame: Record<string, unknown>, handle = handleRequest): Promise<any> {
  return new Promise((resolve) => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      write.mockRestore();
      resolve(JSON.parse(String(chunk)));
      return true;
    });
    void handle(frame);
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.stubEnv("OMB_TURN_DEPTH", "0"); });
afterAll(() => { vi.unstubAllEnvs(); });

it.each([0, 1])("replays recorded agent requests at depth %s", async (depth) => {
  vi.stubEnv("OMB_TURN_DEPTH", String(depth));
  vi.resetModules();
  const handle = depth === 0 ? handleRequest : (await import("./agents-proxy.ts")).handle;
  const list = await rpc(reply.list, handle);
  const names = list.result.tools.map((tool: { name: string }) => tool.name);
  expect(names).toContain("check_delegation");
  expect(names.includes("ask_bot")).toBe(depth === 0);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "done", toBotName: "Helper", result: "All done." })));
  vi.stubGlobal("fetch", fetch);
  const result = await rpc({ jsonrpc: "2.0", id: delegation.call.id, method: "tools/call", params: {
    name: delegation.call.name.replace("mcp__agents__", ""), arguments: delegation.call.input,
  } }, handle);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(`http://127.0.0.1:8799/api/internal/delegations/${delegation.call.input.task_id}?fromBotId=fixture-bot&fromThreadId=fixture-thread&wait_ms=0`, expect.objectContaining({
    headers: expect.objectContaining({ authorization: "Bearer fixture-token" }),
  }));
  expect(result).toMatchObject({ id: delegation.call.id, result: { isError: false, content: [{ type: "text", text: `@Helper finished task ${delegation.call.input.task_id}:\nAll done.` }] } });

  fetch.mockClear();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ botName: "Helper", text: "hi from helper" })));
  const ask = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "ask_bot", arguments: { bot_id: "helper", message: "hello" },
  } }, handle);
  expect(ask).toMatchObject({ id: 3, result: { isError: depth > 0, content: [{ type: "text", text: depth > 0
    ? "ask_bot is unavailable in peer turns."
    : "Helper replied:\nhi from helper" }] } });
  if (depth > 0) {
    expect(fetch).not.toHaveBeenCalled();
  } else {
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8799/api/internal/ask-bot", expect.objectContaining({
      method: "POST", body: JSON.stringify({ fromBotId: "fixture-bot", fromThreadId: "fixture-thread", toBotId: "helper", message: "hello", depth: 0 }),
    }));
  }
});

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
    const { handle } = await import("./agents-proxy.ts");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const list = await rpc(reply.list, handle);
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("report_issue");
    expect(await rpc(reply.call, handle)).toMatchObject({ id: reply.call.id, error: { code: -32602, message: "Unknown tool: report_issue" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
