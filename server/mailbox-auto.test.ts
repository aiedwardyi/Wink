import { describe, expect, it, vi } from "vitest";

import * as mailbox from "./mailbox.ts";
import { terminalReadGrant } from "./terminal-grant.ts";

const ACCESS = { url: "http://127.0.0.1:1", token: "bridge-secret" };
const SCOPE = { bot: "worker", pane: "pane-1" };

describe("mailbox turn-end delivery", () => {
  it("queues the original text at the private bridge without delivering a note", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"raised":true}'));
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ACCESS.url}/v1/bots/worker/terminal/attention`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${terminalReadGrant(ACCESS.token, "worker")}`);
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "pane-1", kind: "auto", text: "done" });
  });

  it("fails closed when the bridge or pane is unavailable", async () => {
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect(await mailbox.deferMailboxAuto(null, SCOPE, "done", down)).toBe(false);
    expect(down).not.toHaveBeenCalled();
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", down)).toBe(false);
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", async () => new Response('{"raised":false}'))).toBe(false);
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", async () => new Response('{"raised":true}', { status: 503 }))).toBe(false);
  });

  it("carries the original identity to the deferred watcher", async () => {
    const identity = { messageId: "123e4567-e89b-12d3-a456-426614174000", sentAt: Date.now(), queued: true as const };
    let body;
    expect(await mailbox.deferMailboxAuto(ACCESS, SCOPE, "done", async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('{"raised":true}');
    }, identity)).toBe(true);
    expect(body).toEqual({ sessionId: "pane-1", kind: "auto", text: "done", identity });
  });

});
