import { describe, expect, it, vi } from "vitest";

import {
  canPrefetchChat,
  chatFrameAfterSnapshot,
  createChatSnapshotLoad,
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
    ["https://[::1]:8799", true],
    ["https://localhost:9484", true],
    ["https://127.0.0.1:9484", true],
    ["https://phone.example", true],
    ["http://192.168.1.2:8799", true],
    ["http://127.0.0.1.example", true],
    ["http://localhost.example", true],
    ["file:///app/index.html", false],
  ])("prefetches HTTP origins at boot: %s", (origin, expected) => {
    expect(canPrefetchChat(new URL(origin))).toBe(expected);
  });
});

describe("chat snapshot retry failure", () => {
  it("returns after a failed retry and waits for the next hello to load again", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ cursor: "s:1" })
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ cursor: "s:3" });
    const snapshots = createChatSnapshotLoad(fetch, () => true);
    snapshots.prefetch();
    await expect(snapshots.load(() => "s:2")).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(snapshots.load(() => "s:3")).resolves.toEqual({ cursor: "s:3" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("chat snapshot frame reconciliation", () => {
  it("skips numbered chat frames already in the snapshot", () => {
    expect(chatFrameAfterSnapshot({ kind: "bot", seq: 2 }, "s:3")).toBe(false);
    expect(chatFrameAfterSnapshot({ kind: "message.patch", seq: 3 }, "s:3")).toBe(false);
    expect(chatFrameAfterSnapshot({ kind: "message", seq: 4 }, "s:3")).toBe(true);
  });

  it("keeps transient, peripheral and unnumbered frames", () => {
    for (const kind of ["runtime", "screen", "config", "instances", "notify", "routine"]) {
      expect(chatFrameAfterSnapshot({ kind, seq: 2 }, "s:3")).toBe(true);
    }
    expect(chatFrameAfterSnapshot({ kind: "bot" }, "s:3")).toBe(true);
    expect(chatFrameAfterSnapshot({ kind: "bot", seq: 2 })).toBe(true);
  });
});

describe("first chat snapshot keeps engine describe off the composer path", () => {
  it("loads config and routines with chat", () => {
    expect(firstChatPeripherals([
      { key: "instances" },
      { key: "config" },
      { key: "routines" },
    ]).map((part) => part.key)).toEqual(["config", "routines"]);
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
