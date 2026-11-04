// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsageBoardClient, mergeBoard, checkedMain } from "./usage-board-client";
import { usageBoardFixture } from "./usage-board.fixture";
import type { UsageBoard, UsageBoardSample } from "./usage-board";

const fresh = (patch: Partial<UsageBoard> = {}): UsageBoard => ({ ...structuredClone(usageBoardFixture), ...patch });
const claude = (board: UsageBoard) => board.engines.find((engine) => engine.engine === "claude")!;
const account = (board: UsageBoard, id: string) => claude(board).accounts.find((each) => each.id === id)!;
const samples = (from: number, count: number, used = 10): UsageBoardSample[] =>
  Array.from({ length: count }, (_, i) => [from + i, used, used]);

describe("mergeBoard", () => {
  it.each([
    ["equal", 42],
    ["older", 41],
  ])("drops a reply whose revision is %s", (_name, revision) => {
    expect(mergeBoard(fresh(), fresh({ revision }))).toBeNull();
  });

  it("takes the first reply whatever its revision", () => {
    const reply = fresh({ revision: 1, full: false });
    expect(mergeBoard(null, reply)).toBe(reply);
  });

  it("replaces on a full reply, so a missing account is gone with its history", () => {
    const reply = fresh({ revision: 43, cursor: "c-43" });
    claude(reply).accounts = claude(reply).accounts.filter((each) => each.id !== "claude");
    const merged = mergeBoard(fresh(), reply)!;
    expect(merged).toBe(reply);
    expect(claude(merged).accounts.some((each) => each.id === "claude")).toBe(false);
  });

  it("upserts a partial by minute, fine and coarse apart, keeping earlier points", () => {
    const shown = fresh();
    account(shown, "claude").history = { fine: [[100, 1, 1], [101, 2, 2]], coarse: [[100, 50, 50]] };
    const reply = fresh({ revision: 43, full: false, cursor: "c-43" });
    account(reply, "claude").history = { fine: [[101, 9, 9], [102, 3, 3]], coarse: [] };
    const merged = account(mergeBoard(shown, reply)!, "claude").history;
    expect(merged.fine).toEqual([[100, 1, 1], [101, 9, 9], [102, 3, 3]]);
    expect(merged.coarse).toEqual([[100, 50, 50]]);
  });

  it("upserts events by seq and keeps the newest 64", () => {
    const shown = fresh();
    claude(shown).events = Array.from({ length: 64 }, (_, i) => ({ seq: i + 1, at: i, kind: "limit" as const }));
    const reply = fresh({ revision: 43, full: false });
    claude(reply).events = [{ seq: 64, at: 99, kind: "reset" }, { seq: 65, at: 100, kind: "main", from: "a", to: "b" }];
    const events = claude(mergeBoard(shown, reply)!).events;
    expect(events).toHaveLength(64);
    expect(events[0]!.seq).toBe(2);
    expect(events.find((event) => event.seq === 64)!.kind).toBe("reset");
    expect(events.at(-1)!.seq).toBe(65);
  });

  it.each([
    ["fine", 288],
    ["coarse", 168],
  ] as const)("trims %s history to %i", (column, cap) => {
    const shown = fresh();
    account(shown, "claude").history = { fine: [], coarse: [], [column]: samples(0, cap) };
    const reply = fresh({ revision: 43, full: false });
    account(reply, "claude").history = { fine: [], coarse: [], [column]: samples(cap, 5) };
    const merged = account(mergeBoard(shown, reply)!, "claude").history[column];
    expect(merged).toHaveLength(cap);
    expect(merged[0]![0]).toBe(5);
    expect(merged.at(-1)![0]).toBe(cap + 4);
  });

  it("keeps the new cursor and takes new windows and roster from a partial", () => {
    const reply = fresh({ revision: 43, full: false, cursor: "c-43" });
    account(reply, "claude").windows[0]!.usedPercent = 90;
    const merged = mergeBoard(fresh(), reply)!;
    expect(merged.cursor).toBe("c-43");
    expect(account(merged, "claude").windows[0]!.usedPercent).toBe(90);
  });
});

describe("createUsageBoardClient", () => {
  let reads: Array<{ cursor: string | null; resolve: (board: UsageBoard) => void; reject: (error: unknown) => void }>;
  let saves: Array<{ id: string; resolve: () => void; reject: (error: unknown) => void }>;
  let make: () => ReturnType<typeof createUsageBoardClient>;
  const stops: Array<() => void> = [];
  const flush = () => new Promise<void>((done) => setTimeout(done, 0));

  beforeEach(() => {
    reads = [];
    saves = [];
    make = () => {
      const client = createUsageBoardClient(
        (cursor) => new Promise((resolve, reject) => reads.push({ cursor, resolve, reject })),
        (id) => new Promise((resolve, reject) => saves.push({ id, resolve: () => resolve(undefined), reject })),
      );
      const subscribe = client.subscribe;
      client.subscribe = (listener) => { const stop = subscribe(listener); stops.push(stop); return stop; };
      return client;
    };
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("reads nothing until subscribed, then full first and by cursor after", async () => {
    const client = make();
    expect(reads).toHaveLength(0);
    const stop = client.subscribe(() => {});
    expect(reads.map((read) => read.cursor)).toEqual([null]);
    reads[0]!.resolve(fresh());
    await flush();
    client.frame(43);
    expect(reads.map((read) => read.cursor)).toEqual([null, "fixture-42"]);
    stop();
  });

  it("keeps one read in flight and coalesces triggers into one follow-up", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    client.frame(43);
    client.frame(44);
    client.invalidate();
    window.dispatchEvent(new Event("focus"));
    expect(reads).toHaveLength(2);
    reads[1]!.resolve(fresh({ revision: 43, cursor: "c-43", full: false }));
    await flush();
    expect(reads).toHaveLength(3);
    expect(reads[2]!.cursor).toBe("c-43");
    reads[2]!.resolve(fresh({ revision: 44, cursor: "c-44", full: false }));
    await flush();
    expect(reads).toHaveLength(3);
  });

  it("ignores a frame whose revision is not higher", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    client.frame(42);
    client.frame(41);
    expect(reads).toHaveLength(1);
  });

  it("waits while hidden and reads once on return", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    client.frame(43);
    client.frame(44);
    expect(reads).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reads).toHaveLength(2);
  });

  it("stops listening for focus when the last subscriber leaves", async () => {
    const client = make();
    const stop = client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(reads).toHaveLength(1);
  });

  it("keeps the last good board when a read fails", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    client.frame(43);
    reads[1]!.reject(new Error("404"));
    await flush();
    expect(client.snapshot().status).toBe("error");
    expect(client.snapshot().board!.revision).toBe(42);
  });

  it("treats a reply that is not a board as a failed read", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve({ report: {} } as unknown as UsageBoard);
    await flush();
    expect(client.snapshot()).toMatchObject({ board: null, status: "error" });
  });

  it("confirms Main only from a read started after the save resolved", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    client.requestMain("claude", "acct-b");
    client.requestMain("claude", "acct-c");
    expect(saves.map((save) => save.id)).toEqual(["acct-b"]);
    expect(checkedMain(client.snapshot(), "claude")).toBe("claude");
    client.frame(43);
    expect(reads).toHaveLength(2);
    saves[0]!.resolve();
    await flush();
    const early = fresh({ revision: 43 });
    claude(early).mainId = "acct-b";
    reads[1]!.resolve(early);
    await flush();
    expect(client.snapshot().pending.claude).toBeDefined();
    expect(checkedMain(client.snapshot(), "claude")).toBe("claude");
    expect(reads).toHaveLength(3);
    const confirm = fresh({ revision: 44 });
    claude(confirm).mainId = "acct-b";
    reads[2]!.resolve(confirm);
    await flush();
    expect(client.snapshot().pending.claude).toBeUndefined();
    expect(checkedMain(client.snapshot(), "claude")).toBe("acct-b");
  });

  it("ends the wait when the confirming read names another Main", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    client.requestMain("claude", "acct-b");
    saves[0]!.resolve();
    await flush();
    const other = fresh({ revision: 43 });
    claude(other).mainId = "acct-z";
    reads[1]!.resolve(other);
    await flush();
    expect(client.snapshot().pending.claude).toBeUndefined();
    expect(checkedMain(client.snapshot(), "claude")).toBe("acct-z");
  });

  it("keeps one pending save per engine and leaves other engines free", async () => {
    const client = make();
    client.subscribe(() => {});
    reads[0]!.resolve(fresh());
    await flush();
    client.requestMain("claude", "acct-b");
    client.requestMain("codex", "acct-x");
    client.requestMain("claude", "acct-b");
    expect(saves.map((save) => save.id)).toEqual(["acct-b", "acct-x"]);
  });

  it("marks a failed save, keeps Main and never confirms by time", async () => {
    vi.useFakeTimers();
    try {
      const client = make();
      client.subscribe(() => {});
      reads[0]!.resolve(fresh());
      await vi.advanceTimersByTimeAsync(0);
      client.requestMain("claude", "acct-b");
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(client.snapshot().pending.claude).toBeDefined();
      expect(reads).toHaveLength(1);
      saves[0]!.reject(new Error("409"));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.snapshot().pending.claude).toBeUndefined();
      expect(client.snapshot().failed.has("claude")).toBe(true);
      expect(checkedMain(client.snapshot(), "claude")).toBe("claude");
      expect(reads).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
