import { afterAll, afterEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("OMB_BOT_ID", "fixture-bot");
  vi.stubEnv("OMB_THREAD_ID", "fixture-room");
  vi.stubEnv("OMB_COMMS_TOKEN", "fixture-token");
  vi.stubEnv("OMB_HARNESS_URL", "http://127.0.0.1:8799");
  vi.stubEnv("OMB_TURN_DEPTH", "0");
  vi.stubEnv("OMB_OWNER_CHATS", "1");
});

function rpc(handle: (msg: Record<string, unknown>) => Promise<unknown>, frame: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      write.mockRestore();
      resolve(JSON.parse(String(chunk)));
      return true;
    });
    void handle(frame);
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); });

it.each([0, 1])("searches the owner's chats from a room turn at depth %s", async (depth) => {
  vi.stubEnv("OMB_TURN_DEPTH", String(depth));
  vi.resetModules();
  const { handle } = await import("./agents-proxy.ts");
  const list = await rpc(handle, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain("search_my_chats");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "[Private: from your 1:1 with Edward. Share only what this task needs.]\n- hit" })));
  vi.stubGlobal("fetch", fetch);
  const result = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_my_chats", arguments: { query: "starzum" } } });
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8799/api/internal/my-chats", expect.objectContaining({
    method: "POST", body: JSON.stringify({ query: "starzum" }), headers: expect.objectContaining({ authorization: "Bearer fixture-token" }),
  }));
  expect(result.result).toEqual({ isError: false, content: [{ type: "text", text: "[Private: from your 1:1 with Edward. Share only what this task needs.]\n- hit" }] });
});

it("is not offered outside a room turn", async () => {
  vi.stubEnv("OMB_OWNER_CHATS", "0");
  vi.resetModules();
  const { handle } = await import("./agents-proxy.ts");
  const list = await rpc(handle, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("search_my_chats");
  const call = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_my_chats", arguments: { query: "x" } } });
  expect(call.error.message).toBe("Unknown tool: search_my_chats");
});
