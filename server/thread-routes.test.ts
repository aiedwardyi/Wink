import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createThreadRoutes } from "./thread-routes.ts";

function pager() {
  vi.useFakeTimers();
  const messagePage = vi.fn(() => ({ messages: [], hasMore: true }));
  const route = createThreadRoutes({
    dataDir: DATA_DIR, store: { botByThread: () => ({}), messagesFor: () => [{ id: "cursor" }] },
    threadSyncGate: { enabled: false }, pullSyncedThread: vi.fn(), DEFAULT_PAGE: 50,
    pageSize: (raw: string | null) => raw === null ? undefined : Math.min(Number(raw), 200), messagePage, messageWindow: vi.fn(() => ({ messages: [], hasMore: false })),
  } as unknown as Parameters<typeof createThreadRoutes>[0]);
  const request = async (query: string) => {
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; }, end: vi.fn() } as unknown as ServerResponse;
    await route.listMessages(res, ["", "thread"] as RegExpMatchArray, new URL(`http://localhost/messages?${query}`));
    return status;
  };
  return { request, messagePage };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("older message batches", () => {
  it("returns five bounded pages in one request", async () => {
    const { request, messagePage } = pager();
    expect(await request("limit=200&before=cursor&pages=5")).toBe(200);
    expect(messagePage).toHaveBeenCalledExactlyOnceWith("thread", 1000, "cursor");
  });

  it("keeps ordinary pages bounded", async () => {
    const { request, messagePage } = pager();
    expect(await request("limit=1000&before=cursor")).toBe(200);
    expect(messagePage).toHaveBeenCalledExactlyOnceWith("thread", 200, "cursor");
  });

  it.each(["pages=0&before=cursor", "pages=6&before=cursor", "pages=1.5&before=cursor", "pages=no&before=cursor", "pages=5", "around=cursor&pages=5"])("rejects an invalid batch: %s", async (query) => {
    const { request, messagePage } = pager();
    expect(await request(query)).toBe(400);
    expect(messagePage).not.toHaveBeenCalled();
  });
});
