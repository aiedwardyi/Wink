import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { userWords } from "./auto-routing-attrib.ts";
import { createAutoRoutingService } from "./auto-routing-service.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { CommsCallers } from "./comms-caller.ts";
import { DATA_DIR } from "./config.ts";
import { planCompaction } from "./context-compaction.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

function fixture() {
  const store = new Store(() => ({ instanceId: "codex", model: "gpt-6.1-sol" }));
  const bot = store.createBot();
  const service = createAutoRoutingService(join(DATA_DIR, randomUUID()), store);
  service.setEnabled(bot.id, true);
  const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Use Sol max" });
  turnRegistry.start(randomUUID(), { botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0, userKeys: [message.id] });
  return { store, bot, service, message };
}
const pick = { op: "pick", target: "worker", model: "gpt-6.1-sol", effort: "max", quote: "Sol max" };
function http(body: Record<string, string | boolean>, authorization?: string) {
  const req = new IncomingMessage(new Socket());
  req.headers = { authorization };
  let result: unknown;
  const res = Object.assign(new ServerResponse(req), { end(value: string) { result = JSON.parse(value); return this; } });
  queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  return { req, res, result: () => result, status: () => res.statusCode };
}

describe("mounted Auto control routes", () => {
  it("binds auto_rule to its bearer and ignores supplied caller identities", async () => {
    const f = fixture();
    const callers = new CommsCallers();
    // SAFETY: This route reads only these dependencies; other handlers are never invoked.
    const routes = createInternalRoutes({ store: f.store, autoRouting: f.service, resolveCommsCaller: (header) => callers.resolve(header) } as Parameters<typeof createInternalRoutes>[0]);
    const denied = http(pick, "Bearer unknown");
    await routes.autoRule(denied.req, denied.res);
    expect(denied.status()).toBe(403);
    const token = callers.token(f.bot.id, f.bot.threadId);
    const forged = http({ ...pick, fromBotId: "other", fromThreadId: "other" }, `Bearer ${token}`);
    await routes.autoRule(forged.req, forged.res);
    expect(forged.result()).toMatchObject({ applied: false });
    const request = http(pick, `Bearer ${token}`);
    await routes.autoRule(request.req, request.res);
    expect(request.result()).toEqual({ applied: true });
    expect(f.service.state.pick(f.bot.id, f.bot.threadId, f.bot.threadId)?.model).toBe("gpt-6.1-sol");
  });

  it("restores the captured pick through the trusted UI route", async () => {
    const f = fixture();
    f.service.tool(f.bot.id, f.bot.threadId, pick);
    const row = f.store.messagesFor(f.bot.threadId).find((line) => line.autoChange)?.autoChange;
    // SAFETY: The Undo handler reads only the store and local Auto service.
    const routes = createBotChatRoutes({ store: f.store, autoRouting: f.service } as Parameters<typeof createBotChatRoutes>[0]);
    const match = `/api/bots/${f.bot.id}`.match(/^\/api\/bots\/([\w-]+)$/)!;
    const request = http({ id: row!.id, threadId: f.bot.threadId });
    await routes.autoRouting(request.req, request.res, match, true);
    expect(request.status()).toBe(200);
    expect(request.result()).toEqual({ applied: true });
    expect(f.service.state.pick(f.bot.id, f.bot.threadId, f.bot.threadId)).toBeUndefined();
    const repeated = http({ id: row!.id, threadId: f.bot.threadId });
    await routes.autoRouting(repeated.req, repeated.res, match, true);
    expect(repeated.status()).toBe(409);
  });

  it("skips display-only rows in replay and removes older Undo payloads", () => {
    const f = fixture();
    const baseline = planCompaction({ messages: f.store.activePath(f.bot.threadId), contextWindow: 100000 });
    f.service.tool(f.bot.id, f.bot.threadId, pick);
    f.service.tool(f.bot.id, f.bot.threadId, pick);
    const rows = f.store.messagesFor(f.bot.threadId).filter((line) => line.autoChange);
    expect(rows.map((line) => line.autoChange!.undoable)).toEqual([false, true]);
    expect(rows.every((line) => line.kind === "activity" && !line.tool)).toBe(true);
    expect(planCompaction({ messages: f.store.activePath(f.bot.threadId), contextWindow: 100000 })).toEqual(baseline);
  });

  it("rejects synced replacements even when they reuse a live user key", () => {
    const f = fixture();
    expect(userWords(f.service.source(f.bot.id, f.bot.threadId))).toBe("Use Sol max");
    const replacement = { ...f.message, text: "Use Opus max" };
    f.store.applySyncChanges(f.bot.id, f.bot.threadId, [{ cursor: 1, kind: "row", rowId: replacement.id, value: replacement, conflict: false }]);
    expect(userWords(f.service.source(f.bot.id, f.bot.threadId))).toBe("");
    expect(f.service.tool(f.bot.id, f.bot.threadId, { ...pick, model: "claude-opus-5-5", quote: "Opus max" })).toMatchObject({ applied: false });
  });
});
