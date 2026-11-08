import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_EVENTS_STALE_MS,
  LIVE_EVENTS_WAKE_QUIET_MS,
  isLivePing,
  liveEventsUrl,
  openLiveEvents,
  shouldReconnectLiveEvents,
  type LiveEventSourceLike,
  type LiveEventsPlatform,
} from "./live-events";

const { firstStreamId, noteResumeCurrent, noteSse } = vi.hoisted(() => ({ firstStreamId: vi.fn(), noteResumeCurrent: vi.fn(), noteSse: vi.fn() }));
vi.mock("./cold-open-timing", async (importOriginal) => ({ ...(await importOriginal<object>()), firstStreamId, noteResumeCurrent, noteSse }));

class FakeTarget {
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  open() {
    this.onopen?.();
  }

  error() {
    this.onerror?.();
  }

  message<T extends { kind: string }>(frame: T, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

function harness(options?: { online?: boolean; visible?: boolean; now?: number }) {
  const sources: FakeEventSource[] = [];
  const windowTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  let online = options?.online ?? true;
  let visible = options?.visible ?? true;
  let now = options?.now ?? 0;
  const platform: LiveEventsPlatform = {
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    windowTarget,
    documentTarget,
    isOnline: () => online,
    isVisible: () => visible,
    now: () => now,
  };
  return {
    sources,
    platform,
    windowTarget,
    documentTarget,
    setOnline(value: boolean) {
      online = value;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  noteSse.mockClear();
  noteResumeCurrent.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("live events URL", () => {
  it("builds cold, resumable, and screen-free stream URLs", () => {
    expect(liveEventsUrl()).toBe("/api/events");
    expect(liveEventsUrl({ screens: true })).toBe("/api/events");
    expect(liveEventsUrl({ since: "ab12cd34:9" })).toBe("/api/events?since=ab12cd34%3A9");
    expect(liveEventsUrl({ since: "ab12cd34:9", screens: false })).toBe(
      "/api/events?since=ab12cd34%3A9&screens=off",
    );
    expect(liveEventsUrl({ screens: false })).toBe("/api/events?screens=off");
    expect(liveEventsUrl({ coldOpen: "0123456789abcdef" })).toBe("/api/events?coldOpen=0123456789abcdef");
  });
});

describe("live events supervisor", () => {
  it("tells the cold-open timing about the first stream only", () => {
    const test = harness();
    firstStreamId.mockReturnValueOnce("0123456789abcdef");
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    expect(test.sources[0].url).toBe("/api/events?coldOpen=0123456789abcdef");
    test.sources[0].error();
    vi.advanceTimersByTime(500);
    expect(test.sources[1].url).toBe("/api/events");
    test.sources[1].open();
    expect(noteSse.mock.calls).toEqual([["created"], ["error"], ["created"], ["open"]]);
    stop();
  });

  it("uses data pings as liveness without forwarding them", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );

    expect(test.sources).toHaveLength(1);
    test.sources[0].open();
    test.sources[0].message({ kind: "message" }, "run00000:4");
    test.setNow(900);
    test.sources[0].message({ kind: "ping" }, "run00000:999");
    vi.advanceTimersByTime(1_500);
    test.setNow(1_899);
    expect(test.sources).toHaveLength(1);
    expect(onFrame).toHaveBeenCalledOnce();

    test.setNow(1_900);
    vi.advanceTimersByTime(500);
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4");
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("ignores frames from a stream generation after replacing it", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, retryMinMs: 100, retryMaxMs: 100 },
      test.platform,
    );
    const staleHandler = test.sources[0].onmessage;

    test.sources[0].error();
    vi.advanceTimersByTime(100);
    staleHandler?.({ data: JSON.stringify({ kind: "message", value: "stale" }), lastEventId: "old:9" });
    test.sources[1].message({ kind: "message", value: "current" }, "new:1");

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledWith({ kind: "message", value: "current" });
    stop();
  });

  it("marks the frames a resumed hello replays", () => {
    const test = harness();
    const frames: unknown[] = [];
    const stop = openLiveEvents(
      { onFrame: (frame) => frames.push(frame), onSnapshotRequired: async () => true },
      test.platform,
    );

    test.sources[0].message({ kind: "hello", resumed: true, cursor: "run00000:5" });
    test.sources[0].message({ kind: "message", value: "missed" }, "run00000:5");
    test.sources[0].message({ kind: "message", value: "live" }, "run00000:6");
    expect(frames).toEqual([
      { kind: "message", value: "missed", replayed: true },
      { kind: "message", value: "live" },
    ]);
    stop();
  });

  it("commits a refused-resume boundary only after its replacement snapshot succeeds", async () => {
    const test = harness();
    const frames: unknown[] = [];
    const snapshotResolutions: Array<(loaded: boolean) => void> = [];
    const stop = openLiveEvents(
      {
        onFrame: (frame) => frames.push(frame),
        onSnapshotRequired: () =>
          new Promise<boolean>((resolve) => snapshotResolutions.push(resolve)),
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.sources[0].message({ kind: "message" }, "oldrun00:10");
    test.sources[0].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[1].url).toBe("/api/events?since=oldrun00%3A10");

    // The server has three replay frames queued. If the socket dies before
    // they arrive, the next attempt still asks from the last consumed frame.
    test.sources[1].message({ kind: "hello", resumed: true, cursor: "oldrun00:13" });
    test.sources[1].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[2].url).toBe("/api/events?since=oldrun00%3A10");

    // A restart/expired replay window has no frames to replay. Application
    // frames may arrive while the consumer rebuilds, but neither their id nor
    // the hello boundary is safe until that replacement snapshot succeeds.
    test.sources[2].message({ kind: "hello", resumed: false, cursor: "newrun00:7" });
    test.sources[2].message({ kind: "message", value: "behind failed snapshot" }, "newrun00:8");
    snapshotResolutions.shift()?.(false);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(test.sources[3].url).toBe("/api/events?since=oldrun00%3A10");

    test.sources[3].message({ kind: "hello", resumed: false, cursor: "newrun00:8" });
    test.sources[3].message({ kind: "message", value: "after snapshot" }, "newrun00:9");
    snapshotResolutions.shift()?.(true);
    await Promise.resolve();
    test.sources[3].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[4].url).toBe("/api/events?since=newrun00%3A9");
    expect(frames).toEqual([
      { kind: "message" },
      { kind: "message", value: "behind failed snapshot" },
      { kind: "message", value: "after snapshot" },
    ]);
    stop();
  });

  it("caps retry backoff when opening the stream keeps failing", () => {
    const attempts: number[] = [];
    const onError = vi.fn();
    const platform: LiveEventsPlatform = {
      createEventSource: () => {
        attempts.push(Date.now());
        throw new Error("offline");
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };

    vi.setSystemTime(0);
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        onError,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      platform,
    );
    vi.advanceTimersByTime(1_100);

    expect(attempts).toEqual([0, 100, 300, 700, 1_100]);
    expect(onError).toHaveBeenCalledTimes(5);
    stop();
  });

  it("backs off an open/error flap until the stream survives a heartbeat", () => {
    const test = harness();
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      test.platform,
    );

    test.sources[0].open();
    test.sources[0].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    test.sources[1].open();
    test.sources[1].error();
    vi.advanceTimersByTime(199);
    expect(test.sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    test.sources[2].open();
    test.sources[2].message({ kind: "ping" });
    test.sources[2].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(test.sources).toHaveLength(4);
    stop();
  });

  it("keeps a healthy visible stream on focus and replays after hiding", () => {
    const test = harness();
    const onError = vi.fn();
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, onError },
      test.platform,
    );
    test.sources[0].message({ kind: "hello", resumed: true, cursor: "run00000:4" });
    test.sources[0].message({ kind: "message" }, "run00000:4");

    test.windowTarget.emit("focus");
    test.windowTarget.emit("focus");
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();

    test.setVisible(false);
    test.documentTarget.emit("visibilitychange");
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4");
    expect(onError).not.toHaveBeenCalled();

    test.sources[1].message({ kind: "hello", resumed: true, cursor: "run00000:4" });
    test.windowTarget.emit("focus");
    expect(test.sources).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it("reports an outage on wake only when the hidden stream went stale", () => {
    const test = harness();
    const onError = vi.fn();
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, onError, staleMs: 1_000 },
      test.platform,
    );
    test.sources[0].message({ kind: "hello", resumed: true, cursor: "run00000:4" });

    test.setVisible(false);
    test.documentTarget.emit("visibilitychange");
    test.setNow(500);
    test.sources[0].message({ kind: "ping" });
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();

    test.sources[1].message({ kind: "hello", resumed: true, cursor: "run00000:4" });
    test.setVisible(false);
    test.documentTarget.emit("visibilitychange");
    test.setNow(5_000);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(3);
    expect(onError).toHaveBeenCalledOnce();
    stop();
  });

  describe("phone resume", () => {
    function resumable() {
      const test = harness();
      const onError = vi.fn();
      const onFrame = vi.fn();
      const stop = openLiveEvents({ onFrame, onError, onSnapshotRequired: async () => true, wakeQuietMs: LIVE_EVENTS_WAKE_QUIET_MS }, test.platform);
      test.sources[0].open();
      test.sources[0].message({ kind: "hello", resumed: false, cursor: "run00000:4" });
      test.sources[0].message({ kind: "message" }, "run00000:5");
      const hide = () => {
        test.setVisible(false);
        test.documentTarget.emit("visibilitychange");
      };
      const resume = (hiddenMs: number) => {
        test.setNow(hiddenMs);
        test.setVisible(true);
        test.documentTarget.emit("visibilitychange");
      };
      return { test, onError, onFrame, stop, hide, resume };
    }

    it.each([
      [30_000, 500, "error"],
      [30_000, 3_000, "error"],
      [300_000, 500, "error"],
      [300_000, 3_000, "error"],
      [300_000, 500, "silent"],
      [300_000, 3_000, "silent"],
    ])("stays quiet after %d ms hidden with the link back at +%d ms (%s drop)", async (hiddenMs, backMs, drop) => {
      const { test, onError, onFrame, stop, hide, resume } = resumable();
      await vi.advanceTimersByTimeAsync(0);
      onFrame.mockClear();
      hide();
      if (drop === "error") test.sources[0].error();
      resume(hiddenMs);

      expect(test.sources).toHaveLength(2);
      expect(test.sources[1].url).toContain("since=run00000%3A5");
      vi.advanceTimersByTime(backMs);
      test.sources[1].open();
      test.sources[1].message({ kind: "hello", resumed: true, cursor: "run00000:7" });
      test.sources[1].message({ kind: "message", n: 6 }, "run00000:6");
      test.sources[1].message({ kind: "message", n: 7 }, "run00000:7");
      vi.advanceTimersByTime(LIVE_EVENTS_WAKE_QUIET_MS * 2);

      expect(onError).not.toHaveBeenCalled();
      expect(onFrame.mock.calls.map(([frame]) => frame.n)).toEqual([6, 7]);
      stop();
    });

    it("wakes a socket that went silent after a hello landed while hidden", () => {
      const { test, onError, stop, hide, resume } = resumable();
      hide();
      test.sources[0].message({ kind: "hello", resumed: true, cursor: "run00000:5" });
      resume(1_000);

      expect(test.sources).toHaveLength(2);
      test.sources[1].open();
      test.sources[1].message({ kind: "hello", resumed: true, cursor: "run00000:5" });
      vi.advanceTimersByTime(LIVE_EVENTS_WAKE_QUIET_MS * 2);
      expect(onError).not.toHaveBeenCalled();
      stop();
    });

    it("counts a replayed chat as current at its hello", () => {
      const { test, stop, hide, resume } = resumable();
      noteResumeCurrent.mockClear();
      hide();
      resume(300_000);
      test.sources[1].open();
      expect(noteResumeCurrent).not.toHaveBeenCalled();
      test.sources[1].message({ kind: "hello", resumed: true, cursor: "run00000:5" });
      expect(noteResumeCurrent).toHaveBeenCalledOnce();
      stop();
    });

    it.each([
      [true, 1],
      [false, 0],
    ])("counts a refused replay as current only once its snapshot loads (loaded %s)", async (loaded, calls) => {
      let finishLoad!: (value: boolean) => void;
      const test = harness();
      const onSnapshotRequired = vi.fn(() => new Promise<boolean>((resolve) => (finishLoad = resolve)));
      const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired, wakeQuietMs: LIVE_EVENTS_WAKE_QUIET_MS }, test.platform);
      test.sources[0].open();
      test.sources[0].message({ kind: "hello", resumed: false, cursor: "run00000:4" });
      expect(noteResumeCurrent).not.toHaveBeenCalled();
      finishLoad(loaded);
      await vi.advanceTimersByTimeAsync(0);
      expect(noteResumeCurrent).toHaveBeenCalledTimes(calls);
      stop();
    });

    it("shows a link still down when the hold runs out", () => {
      const { test, onError, stop, hide, resume } = resumable();
      hide();
      test.sources[0].error();
      resume(300_000);
      vi.advanceTimersByTime(LIVE_EVENTS_WAKE_QUIET_MS - 1);
      expect(onError).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onError).toHaveBeenCalledOnce();
      stop();
    });

    it("shows a resume with no network when the hold runs out", () => {
      const { test, onError, stop, hide, resume } = resumable();
      hide();
      test.sources[0].error();
      test.setOnline(false);
      resume(300_000);
      vi.advanceTimersByTime(LIVE_EVENTS_WAKE_QUIET_MS);
      expect(onError).toHaveBeenCalledOnce();
      stop();
    });

    it("reports a drop once the link is back", () => {
      const { test, onError, stop, hide, resume } = resumable();
      hide();
      resume(300_000);
      test.sources[1].open();
      test.sources[1].error();
      expect(onError).toHaveBeenCalledOnce();
      stop();
    });

    it("drops the hold when the page hides again", () => {
      const { test, onError, stop, hide, resume } = resumable();
      hide();
      resume(300_000);
      hide();
      vi.advanceTimersByTime(LIVE_EVENTS_WAKE_QUIET_MS * 2);
      expect(onError).not.toHaveBeenCalled();
      test.sources[1].error();
      expect(onError).not.toHaveBeenCalled();
      stop();
    });

    it("still reports a drop on a page that never left the screen", () => {
      const { test, onError, stop } = resumable();
      test.sources[0].error();
      expect(onError).toHaveBeenCalledOnce();
      stop();
    });
  });

  it.each(["online", "pageshow"])("forces replay on %s while visible", (event) => {
    const test = harness();
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true },
      test.platform,
    );
    test.sources[0].message({ kind: "message" }, "run00000:4");
    test.windowTarget.emit(event, { persisted: true });
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4");
    stop();
  });

  it.each(["visibilitychange", "focus", "online", "pageshow"])(
    "replays missing messages immediately on %s before the stream is stale",
    (event) => {
      const test = harness();
      const frames: unknown[] = [];
      const onSnapshotRequired = vi.fn(async () => true);
      const stop = openLiveEvents(
        { onFrame: (frame) => frames.push(frame), onSnapshotRequired },
        test.platform,
      );
      test.sources[0].message({ kind: "message", value: "old" }, "run00000:4");
      test.setVisible(false);
      test.documentTarget.emit("visibilitychange");
      test.setNow(1_000);
      test.sources[0].message({ kind: "ping" });
      test.setVisible(true);

      const target = event === "visibilitychange" ? test.documentTarget : test.windowTarget;
      target.emit(event, { persisted: true });
      expect(test.sources).toHaveLength(2);
      expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4");
      expect(frames).toEqual([{ kind: "message", value: "old" }]);

      test.windowTarget.emit("focus");
      test.documentTarget.emit("visibilitychange");
      expect(test.sources).toHaveLength(2);
      test.sources[1].message({ kind: "hello", resumed: true, cursor: "run00000:5" });
      test.sources[1].message({ kind: "message", value: "new" }, "run00000:5");
      expect(frames).toEqual([
        { kind: "message", value: "old" },
        { kind: "message", value: "new", replayed: true },
      ]);
      expect(onSnapshotRequired).not.toHaveBeenCalled();
      stop();
    },
  );

  it("does not churn a suspended hidden stream and recovers once visible", () => {
    const test = harness({ visible: false });
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        staleMs: 1_000,
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.setNow(10_000);
    vi.advanceTimersByTime(10_000);
    expect(test.sources).toHaveLength(1);

    // Even an explicit transport error stays quiet in the background; the
    // visibility edge below is the single owner of recovery.
    test.sources[0].error();
    vi.advanceTimersByTime(1_000);
    expect(test.sources).toHaveLength(1);

    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("reconnects a wake at the minimum delay, not the backoff built before hiding", () => {
    const test = harness();
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        retryMinMs: 100,
        retryMaxMs: 10_000,
        staleMs: 60_000,
      },
      test.platform,
    );

    test.sources[0].error();
    vi.advanceTimersByTime(100);
    test.sources[1].error();
    vi.advanceTimersByTime(200);
    test.sources[2].error();
    test.setVisible(false);
    test.documentTarget.emit("visibilitychange");
    vi.advanceTimersByTime(400);
    expect(test.sources).toHaveLength(3);

    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(4);
    test.sources[3].error();
    vi.advanceTimersByTime(100);
    expect(test.sources).toHaveLength(5);
    stop();
  });

  it("replaces the stream at once when the page comes back from the back/forward cache", () => {
    const test = harness();
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, staleMs: 60_000 },
      test.platform,
    );
    test.sources[0].open();

    test.windowTarget.emit("pageshow", { persisted: false });
    expect(test.sources).toHaveLength(1);
    test.windowTarget.emit("pageshow", { persisted: true });
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();

    stop();
    expect(test.windowTarget.count("pageshow")).toBe(0);
  });

  it("recovers immediately on online/focus/visible and removes every owner on cleanup", () => {
    const test = harness({ online: false });
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );
    expect(test.sources).toHaveLength(0);

    test.setOnline(true);
    test.windowTarget.emit("online");
    expect(test.sources).toHaveLength(1);

    test.setNow(1_001);
    test.windowTarget.emit("focus");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();

    test.setVisible(false);
    test.setNow(2_002);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(3);

    stop();
    stop();
    expect(test.sources[2].close).toHaveBeenCalledOnce();
    expect(test.windowTarget.count("online")).toBe(0);
    expect(test.windowTarget.count("focus")).toBe(0);
    expect(test.documentTarget.count("visibilitychange")).toBe(0);
  });
});

describe("live event liveness predicates", () => {
  it("recognizes only ping frames and reconnects at the stale boundary", () => {
    expect(isLivePing({ kind: "ping" })).toBe(true);
    expect(isLivePing({ kind: "message" })).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS - 1)).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS)).toBe(true);
  });
});
