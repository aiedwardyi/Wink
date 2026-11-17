import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommsCallers } from "./comms-caller.ts";
import { createInternalRoutes } from "./internal-routes.ts";

const callers = new CommsCallers();
const bots: Record<string, { id: string; threadId: string }> = { "bot-a": { id: "bot-a", threadId: "chat-a" }, "bot-b": { id: "bot-b", threadId: "chat-b" } };

function harness(readOnly = false) {
  const fetchSpy = vi.fn(async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
  vi.stubGlobal("fetch", fetchSpy);
  const routes = createInternalRoutes({
    cfg: { xai: { key: "test-key" } },
    store: { bot: (id: string) => bots[id] },
    connectorThread: (botId: string, threadId: string) => (bots[botId]?.threadId === threadId ? {} : undefined),
    botOutputRoots: () => [],
    readOnlyTurn: () => readOnly,
    resolveCommsCaller: (header: string | string[] | undefined) => callers.resolve(header),
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
  const post = async (authorization: string | undefined, body: object) => {
    const req = new EventEmitter() as IncomingMessage;
    req.headers = authorization ? { authorization } : {};
    let status = 0;
    let out = "";
    const res = { writeHead(code: number) { status = code; }, getHeader() {}, setHeader() {}, end(value: string) { out = value; } } as unknown as ServerResponse;
    const pending = routes.callKeyApi(req, res);
    req.emit("data", JSON.stringify({ credentialId: "xaiApiKey", method: "GET", url: "https://api.x.ai/v1/models", ...body }));
    req.emit("end");
    await pending;
    return { status, body: JSON.parse(out) as { error?: string; status?: number } };
  };
  return { post, fetchSpy };
}

const tokenOf = (botId: string) => `Bearer ${callers.token(botId, bots[botId]!.threadId)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("call_api caller", () => {
  it("spends the key for the bot its token belongs to", async () => {
    const h = harness();
    const result = await h.post(tokenOf("bot-a"), { fromBotId: "bot-a", fromThreadId: "chat-a" });
    expect(result).toMatchObject({ status: 200, body: { status: 200 } });
    expect(h.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a token naming another bot or thread", async () => {
    const h = harness();
    expect((await h.post(tokenOf("bot-a"), { fromBotId: "bot-b", fromThreadId: "chat-b" })).status).toBe(403);
    expect((await h.post(tokenOf("bot-a"), { fromBotId: "bot-a", fromThreadId: "chat-b" })).status).toBe(403);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a request without a bot token", async () => {
    const h = harness();
    expect((await h.post(undefined, { fromBotId: "bot-a", fromThreadId: "chat-a" })).status).toBe(403);
    expect((await h.post("Bearer not-a-bot-token", { fromBotId: "bot-a", fromThreadId: "chat-a" })).status).toBe(403);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a read-only turn", async () => {
    const h = harness(true);
    const result = await h.post(tokenOf("bot-a"), { fromBotId: "bot-a", fromThreadId: "chat-a" });
    expect(result.status).toBe(403);
    expect(result.body.error).toContain("Can make bots work");
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a key on its own hosts", async () => {
    const h = harness();
    const result = await h.post(tokenOf("bot-a"), { fromBotId: "bot-a", fromThreadId: "chat-a", url: "https://example.com/v1" });
    expect(result.status).toBe(403);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });
});
