import { afterAll, afterEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("OMB_BOT_ID", "fixture-bot");
  vi.stubEnv("OMB_THREAD_ID", "fixture-room");
  vi.stubEnv("OMB_COMMS_TOKEN", "fixture-token");
  vi.stubEnv("OMB_HARNESS_URL", "http://127.0.0.1:8799");
  vi.stubEnv("OMB_TURN_DEPTH", "0");
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

it("hands a lane turn's work to the harness", async () => {
  vi.stubEnv("OMB_HAND_OFF", "1");
  vi.resetModules();
  const { handle } = await import("./agents-proxy.ts");
  const list = await rpc(handle, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain("hand_off");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "Handed off." }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const result = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hand_off", arguments: {} } });
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8799/api/internal/hand-off", expect.objectContaining({ method: "POST" }));
  expect(result.result.content[0].text).toBe("Handed off.");
});

it("offers no hand_off outside a lane turn", async () => {
  vi.stubEnv("OMB_HAND_OFF", "0");
  vi.resetModules();
  const { handle } = await import("./agents-proxy.ts");
  const list = await rpc(handle, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("hand_off");
});
