import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { CommsCallers } from "./comms-caller.ts";
import { createInternalRoutes } from "./internal-routes.ts";

const callers = new CommsCallers();
const bots: Record<string, { id: string; name: string; threadId: string }> = {
  "bot-a": { id: "bot-a", name: "A", threadId: "chat-a" },
  "bot-b": { id: "bot-b", name: "B", threadId: "chat-b" },
};

function harness(readOnly: boolean) {
  const askBotAndWait = vi.fn(async () => ({ reply: "hi" }));
  const routines = { listRoutines: vi.fn(() => []), addRoutine: vi.fn(), removeRoutine: vi.fn() };
  const routes = createInternalRoutes({
    cfg: { imageGen: { key: "sk-test" } },
    store: { bot: (id: string) => bots[id], dmGroup: () => undefined },
    connectorThread: (botId: string, threadId: string) => (bots[botId]?.threadId === threadId ? {} : undefined),
    botOutputRoots: () => [],
    readOnlyTurn: () => readOnly,
    askBotAndWait,
    routines,
    MAX_COMMS_DEPTH: 1,
    resolveCommsCaller: (header: string | string[] | undefined) => callers.resolve(header),
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
  const post = async (route: "generateImage" | "askBot" | "delegateBot" | "wake", body: object) => {
    const req = new EventEmitter() as IncomingMessage;
    req.headers = { authorization: `Bearer ${callers.token("bot-a", "chat-a")}` };
    let status = 0;
    let out = "";
    const res = { writeHead(code: number) { status = code; }, getHeader() {}, setHeader() {}, end(value: string) { out = value; } } as unknown as ServerResponse;
    const pending = routes[route](req, res);
    req.emit("data", JSON.stringify({ fromBotId: "bot-a", fromThreadId: "chat-a", ...body }));
    req.emit("end");
    await pending;
    return { status, error: (JSON.parse(out || "{}") as { error?: string }).error ?? "" };
  };
  return { post, askBotAndWait, routines };
}

const CALLS = [
  ["generateImage", { prompt: "a cat", size: "1024x1024", quality: "low" }],
  ["askBot", { toBotId: "bot-b", message: "hi" }],
  ["delegateBot", { toBotId: "bot-b", message: "do it" }],
  ["wake", { at: "2099-01-01T00:00:00Z", note: "later" }],
] as const;

describe("Wink tools on a read-only turn", () => {
  it.each(CALLS)("%s is refused", async (route, body) => {
    const h = harness(true);
    const result = await h.post(route, body);
    expect(result.status).toBe(403);
    expect(result.error).toContain("Can make bots work");
    expect(h.askBotAndWait).not.toHaveBeenCalled();
  });

  it.each(CALLS)("%s passes the read-only check on a working turn", async (route, body) => {
    const result = await harness(false).post(route, body);
    expect(result.error).not.toContain("Can make bots work");
  });
});
