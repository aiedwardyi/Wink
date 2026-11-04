import { describe, expect, it, vi } from "vitest";

import { terminalPaneCountsGrant } from "./terminal-grant.ts";
import * as panes from "./worker-panes.ts";

const ACCESS = { url: "http://127.0.0.1:52150", token: "bridge-secret" };
const RUN = { botId: "bot-1", paneId: "pane", label: "builder", engine: "claude", accountId: "claude.fixture", accountGeneration: 3, state: "busy" };

describe("live worker runs", () => {
  it("reports an old host as unknown, not empty", async () => {
    expect(panes).toHaveProperty("liveWorkerRuns");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(await panes.liveWorkerRuns(ACCESS, {}, 5_000, fetchImpl)).toEqual({ known: false, reason: "old-host" });
  });

  it("reports a timeout as unknown", async () => {
    expect(panes).toHaveProperty("liveWorkerRuns");
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    expect(await panes.liveWorkerRuns(ACCESS, {}, 10, fetchImpl)).toEqual({ known: false, reason: "timeout" });
  });

  it("validates live runs and sends filters with the pane-counts grant", async () => {
    expect(panes).toHaveProperty("liveWorkerRuns");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ runs: [RUN] })));
    expect(await panes.liveWorkerRuns(ACCESS, { botId: "bot-1", engine: "claude" }, 5_000, fetchImpl)).toEqual({ known: true, runs: [RUN] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ACCESS.url}/v1/terminal/account-runs?botId=bot-1&engine=claude`);
    expect(init?.headers).toEqual({ authorization: `Bearer ${terminalPaneCountsGrant(ACCESS.token)}` });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps no host, bad responses and fetch errors unknown", async () => {
    expect(panes).toHaveProperty("liveWorkerRuns");
    const never = vi.fn();
    expect(await panes.liveWorkerRuns(null, {}, 5_000, never)).toEqual({ known: false, reason: "no-host" });
    expect(never).not.toHaveBeenCalled();
    for (const response of [new Response("{}", { status: 503 }), new Response("{}"), new Response("not json"),
      new Response(JSON.stringify({ runs: [{ ...RUN, accountGeneration: -1 }] })), new Response(JSON.stringify({ runs: [{ ...RUN, state: "exited" }] }))]) {
      expect(await panes.liveWorkerRuns(ACCESS, {}, 5_000, async () => response)).toEqual({ known: false, reason: "error" });
    }
    expect(await panes.liveWorkerRuns(ACCESS, {}, 5_000, async () => { throw new Error("disconnected"); })).toEqual({ known: false, reason: "error" });
    expect(await panes.liveWorkerRuns(ACCESS, {}, 5_000, async () => new Response('{"runs":[]}'))).toEqual({ known: true, runs: [] });
  });
});
