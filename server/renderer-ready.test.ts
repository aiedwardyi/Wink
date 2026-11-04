import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { Server, ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForFirstPage } from "./renderer-ready.ts";

afterEach(() => vi.useRealTimers());

describe("renderer startup", () => {
  it("leaves health and the first HTML response ahead of the fat import", async () => {
    const source = readFileSync(new URL("./packaged-boot.ts", import.meta.url), "utf8");
    const statement = source.split("\n").find((line) => line.startsWith('await startupTiming.track("firstPage"')) ?? "";
    const server = new EventEmitter() as Server;
    const response = new EventEmitter() as ServerResponse;
    let imported = false;
    const boot = runInNewContext(`(async () => { ${statement}; imported(); })()`, {
      startupTiming: { track: (_name: string, work: () => Promise<void>) => work() },
      waitForFirstPage, early: { server }, imported: () => { imported = true; },
    }) as Promise<void>;
    try {
      for (const url of ["/api/health", "/assets/index.js", "/api/internal/google-account"]) {
        server.emit("request", { method: "GET", url }, response);
      }
      server.emit("request", { method: "GET", url: "/" }, response);
      await Promise.resolve();
      expect(imported).toBe(false);
    } finally {
      response.emit("finish");
      await boot;
    }
    expect(imported).toBe(true);
    expect(server.listenerCount("request")).toBe(0);
  });

  it("accepts a direct index page too", async () => {
    const server = new EventEmitter() as Server;
    const response = new EventEmitter() as ServerResponse;
    const ready = waitForFirstPage(server);
    server.emit("request", { method: "GET", url: "/index.html?bot=b1" }, response);
    response.emit("finish");
    await ready;
    expect(server.listenerCount("request")).toBe(0);
  });

  it("still starts when no renderer reaches the listener", async () => {
    vi.useFakeTimers();
    const server = new EventEmitter() as Server;
    const ready = vi.fn();
    void waitForFirstPage(server).then(ready);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toHaveBeenCalledOnce();
    expect(server.listenerCount("request")).toBe(0);
  });
});
