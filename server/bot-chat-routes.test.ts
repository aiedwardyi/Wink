import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";

describe("prewarm route", () => {
  it("prepares the bot's thread with its model, effort and approval", async () => {
    const prepare = vi.fn(async () => {});
    const bot = { id: "b1", threadId: "t1", autoApprove: false, modelSelection: { instanceId: "claude", mode: "pinned", model: "claude-opus-5-5", effort: "medium" } };
    const routes = createBotChatRoutes({ store: { bot: () => bot }, instanceForBot: () => ({ prepare }) } as never);
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;

    await routes.prewarm(res, ["", "b1"] as unknown as RegExpMatchArray);
    expect(prepare).toHaveBeenCalledWith(undefined, { threadId: "t1", model: "claude-opus-5-5", effort: "medium", approval: "ask" });
  });
});
