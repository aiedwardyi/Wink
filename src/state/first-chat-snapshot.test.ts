import { describe, expect, it, vi } from "vitest";

import {
  canPrefetchChat,
  DEFERRED_INSTANCE_IDLE_MS,
  firstChatPeripherals,
  isFirstChatPeripheral,
  scheduleDeferredInstancesLoad,
} from "./first-chat-snapshot";

describe("chat snapshot prefetch", () => {
  it.each([
    ["http://127.0.0.1:8799", true],
    ["http://localhost:8799", true],
    ["http://[::1]:8799", true],
    ["https://localhost:9484", false],
    ["https://127.0.0.1:9484", false],
    ["https://phone.example", false],
    ["http://192.168.1.2:8799", false],
    ["http://127.0.0.1.example", false],
    ["http://localhost.example", false],
    ["file:///app/index.html", false],
  ])("prefetches only the app's HTTP loopback origin: %s", (origin, expected) => {
    expect(canPrefetchChat(new URL(origin))).toBe(expected);
  });
});

describe("first chat snapshot keeps engine describe off the composer path", () => {
  it("loads config, routines, and webhooks with chat — not instances", () => {
    expect(firstChatPeripherals([
      { key: "instances" },
      { key: "config" },
      { key: "routines" },
      { key: "webhooks" },
    ]).map((part) => part.key)).toEqual(["config", "routines", "webhooks"]);
    expect(isFirstChatPeripheral("instances")).toBe(false);
    expect(isFirstChatPeripheral("config")).toBe(true);
  });

  it("wakes the instances scan on idle instead of the first snapshot", () => {
    const wake = vi.fn();
    const cancel = vi.fn();
    const idle = {
      requestIdleCallback: (cb: () => void, opts?: { timeout?: number }) => {
        expect(opts?.timeout).toBe(DEFERRED_INSTANCE_IDLE_MS);
        cb();
        return 7;
      },
      cancelIdleCallback: cancel,
    };
    const stop = scheduleDeferredInstancesLoad(wake, idle);
    expect(wake).toHaveBeenCalledTimes(1);
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
