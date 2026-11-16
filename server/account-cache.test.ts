import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { createUsageRefresh } from "./usage-refresh.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import type { JsonValue } from "./schema.ts";

const sessions = await import("./account-sessions.ts").catch(() => null);
const account = { id: "acct_7d6e234b-8046-4a5a-9354-2cf05f27d775", of: "codex", home: join(DATA_DIR, "accounts", "fixture"), generation: 1 };
const payload = { account: { type: "chatgpt", email: "fixture@example.test" }, rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } } };
afterEach(() => vi.restoreAllMocks());

describe("account cache generations", () => {
  it.each([false, true])("excludes only its completed read from identity observation with overlapping work %s", async (overlap) => {
    let release!: (value: typeof payload) => void;
    const rpc = vi.fn().mockResolvedValueOnce(payload).mockImplementation(() => new Promise((done) => { release = done; }));
    const busy: boolean[] = [];
    const refresh = createUsageRefresh({ rpc, throttleMs: 0, accountIdentity: async () => { busy.push(refresh.busy(account.id)); } });
    let other: Promise<unknown> | undefined;
    if (overlap) {
      rpc.mockReset().mockImplementationOnce(() => new Promise((done) => { release = done; })).mockResolvedValue(payload);
      other = refresh("codex", { instanceId: account.id, account: { ...account, generation: 2 } });
    }
    await refresh("codex", { instanceId: account.id, account });
    expect(busy).toEqual([overlap]);
    if (other) { release(payload); await other; }
    expect(refresh.busy(account.id)).toBe(false);
  });

  it("keys refresh caches by both the immutable id and generation", async () => {
    const rpc = vi.fn(async () => payload);
    const refresh = createUsageRefresh({ rpc });
    await refresh("codex", { instanceId: account.id, account });
    await refresh("codex", { instanceId: account.id, account: { ...account, generation: 2 } });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("discards a retired generation's late usage and identity result", async () => {
    let resolve!: (value: JsonValue) => void;
    const rpc = vi.fn(() => new Promise<JsonValue>((done) => { resolve = done; }));
    const identity = vi.fn(async () => {});
    const refresh = createUsageRefresh({ rpc, accountIdentity: identity });
    const pending = refresh("codex", { instanceId: account.id, account });
    expect(refresh.invalidate, "generation invalidation exists").toBeTypeOf("function");
    refresh.invalidate(account.id);
    resolve(payload);
    expect((await pending).report).toBeUndefined();
    expect(identity).not.toHaveBeenCalled();
  });

  it("invalidates only the selected account's refresh throttle", async () => {
    const rpc = vi.fn(async () => payload);
    const refresh = createUsageRefresh({ rpc });
    const sibling = { ...account, id: "acct_6d6e234b-8046-4a5a-9354-2cf05f27d775" };
    await refresh("codex", { instanceId: account.id, account });
    await refresh("codex", { instanceId: sibling.id, account: sibling });
    expect(refresh.invalidate, "generation invalidation exists").toBeTypeOf("function");
    refresh.invalidate(account.id);
    await refresh("codex", { instanceId: sibling.id, account: sibling });
    await refresh("codex", { instanceId: account.id, account });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("drops only that account's cursors, seeds, native prompt and session-system files", () => {
    expect(sessions, "account session invalidation exists").not.toBeNull();
    const store = new Store(() => ({ instanceId: "codex", model: "gpt-6.1-sol" }));
    const bot = store.createBot({ name: "Fixture" });
    const task = store.activeTask(bot.id)!;
    store.setResumeCursor(bot.id, account.id, "account-cursor");
    store.setResumeCursor(bot.id, "codex", "base-cursor");
    store.recordSessionSystem(account.id, "account-cursor", "account system");
    store.recordSessionSystem("codex", "base-cursor", "base system");
    task.resumeSeed = { instanceId: account.id, cursor: "account-cursor", compactionId: "compaction" };
    task.lastInstanceId = account.id;
    task.nativePrompt = { cursor: "account-cursor", first: 10, last: 20 };
    const text = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "keep conversation" });
    const before = JSON.stringify(store.messagesFor(bot.threadId));
    store.clearAccountSessions(account.id);
    expect(task.resumeCursors).toEqual({ codex: "base-cursor" });
    expect(task.resumeSeed).toBeUndefined();
    expect(task.nativePrompt).toBeUndefined();
    expect(store.sessionSystem(account.id, "account-cursor")).toBeUndefined();
    expect(store.sessionSystem("codex", "base-cursor")).toBe("base system");
    expect(JSON.stringify(store.messagesFor(bot.threadId))).toBe(before);
    expect(store.messagesFor(bot.threadId).find((message) => message.id === text.id)?.text).toBe("keep conversation");
  });

  it("does not restore a saved authenticated account probe", async () => {
    const driver = makeFakeDriver({ kind: "codex" }).driver;
    const create = driver.create;
    const snapshot = vi.fn(async () => ({ state: "available" as const, authenticated: true }));
    driver.create = async (input) => ({ ...await create(input), account: input.account, snapshot });
    const configs = { [account.id]: { driver: "codex", account } };
    const first = new ProviderRegistry([driver], { cacheDir: DATA_DIR });
    await first.load(configs);
    await first.describe();
    await first.disposeAll();
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "provider-probes.json"), "utf8"));
    expect(disk[account.id]).toBeDefined();
    expect(disk[account.id].snapshot.authenticated).toBe(true);
    const second = new ProviderRegistry([driver], { cacheDir: DATA_DIR });
    try {
      snapshot.mockClear();
      snapshot.mockResolvedValue({ state: "available", authenticated: false });
      await second.load(configs);
      expect(second.describeSaved()).toEqual([]);
      expect((await second.describeCached())[0].snapshot.authenticated).toBe(false);
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally { await second.disposeAll(); }
  });
});
