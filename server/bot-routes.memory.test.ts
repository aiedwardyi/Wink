import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotRoutes } from "./bot-routes.ts";
import { Store } from "./store.ts";
import { MEMORY_FILE_MAX_BYTES, readMemoryFile, writeMemoryFile } from "./workspace.ts";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  vi.restoreAllMocks();
});

async function harness(recordTypedLines?: (botId: string, before: string, after: string) => void) {
  const store = new Store(() => ({ instanceId: "engine", model: "fake-1" }));
  const bot = store.createBot({ name: "Ada" });
  writeMemoryFile(bot.id, "before\n");
  const refresh = vi.fn();
  const deps: Partial<Parameters<typeof createBotRoutes>[0]> = {
    store,
    memoryHealthCheck: { refresh, refreshAll: vi.fn(), take: vi.fn(), settled: vi.fn() },
    recordTypedLines,
  };
  const routes = createBotRoutes(deps as Parameters<typeof createBotRoutes>[0]);
  const listening = createServer((req, res) => {
    void routes.putMemory(req, res, /^\/api\/bots\/([^/]+)\/memory$/.exec(req.url ?? "")!).catch(() => {
      res.writeHead(500).end();
    });
  });
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const { port } = listening.address() as AddressInfo;
  const save = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/bots/${bot.id}/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { bot, save, refresh };
}

describe("Memory editor recorder", () => {
  it("records the current text and submitted text after a successful save", async () => {
    let savedAtRecord: string | undefined;
    const recordTypedLines = vi.fn((id: string) => {
      savedAtRecord = readMemoryFile(id).text;
    });
    const { bot, save, refresh } = await harness(recordTypedLines);
    writeMemoryFile(bot.id, "current\n");
    const response = await save({ text: "after\n", baseRevision: readMemoryFile(bot.id).revision });
    expect(response.status).toBe(200);
    expect(recordTypedLines).toHaveBeenCalledExactlyOnceWith(bot.id, "current\n", "after\n");
    expect(savedAtRecord).toBe("after\n");
    expect(refresh).toHaveBeenCalledWith(bot.id);
  });

  it("does not record a conflicting save", async () => {
    const recordTypedLines = vi.fn();
    const { bot, save, refresh } = await harness(recordTypedLines);
    expect((await save({ text: "after\n", baseRevision: "stale" })).status).toBe(409);
    expect(recordTypedLines).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(readMemoryFile(bot.id).text).toBe("before\n");
  });

  it.each([{ text: 42 }, { text: "한".repeat(Math.floor(MEMORY_FILE_MAX_BYTES / 3) + 1) }])("does not record a rejected body", async (body) => {
    const recordTypedLines = vi.fn();
    const { bot, save, refresh } = await harness(recordTypedLines);
    expect((await save(body)).status).toBe(400);
    expect(recordTypedLines).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(readMemoryFile(bot.id).text).toBe("before\n");
  });

  it("logs a throwing recorder and still returns a successful save", async () => {
    const recordTypedLines = vi.fn(() => { throw new Error("recorder unavailable"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bot, save, refresh } = await harness(recordTypedLines);
    const response = await save({ text: "after\n" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(readMemoryFile(bot.id).text).toBe("after\n");
    expect(recordTypedLines).toHaveBeenCalledExactlyOnceWith(bot.id, "before\n", "after\n");
    expect(warn).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(bot.id);
  });

  it("saves as before without a recorder", async () => {
    const { bot, save } = await harness();
    const response = await save({ text: "after\n" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, truncated: false, revision: readMemoryFile(bot.id).revision });
    expect(readMemoryFile(bot.id).text).toBe("after\n");
  });
});
