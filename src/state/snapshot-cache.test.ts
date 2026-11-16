import { describe, expect, it, vi } from "vitest";

import { readSnapshotCache, SNAPSHOT_CACHE_KEY, writeSnapshotCache } from "./snapshot-cache";
import type { Bot, Message } from "./store";

const redactions = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../server/redact.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/redact.ts")>();
  return { ...actual, redactSecrets: (value: unknown) => (redactions.count++, actual.redactSecrets(value)) };
});

const KEY = "sk-proj-abcdefghijklmnop1234567890";

class MemoryStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const storage = () => new MemoryStorage() as unknown as Storage & MemoryStorage;

const bot = (messages: Message[]) =>
  ({ id: "b1", threadId: "t1", name: "Scout", unread: false, color: "blue", messages }) as unknown as Bot;

describe("snapshot cache", () => {
  it("redacts secrets from every cached message, user rows included", () => {
    const local = storage();
    const message: Message = { id: "m1", at: 1, role: "user", kind: "text", text: `my key is ${KEY}` };
    writeSnapshotCache({ bots: [bot([message])], groups: [], selectedId: "b1" }, local);
    expect(local.getItem(SNAPSHOT_CACHE_KEY)).not.toContain(KEY);
    expect(readSnapshotCache(local)?.bots[0].messages[0].text).toMatch(/^my key is «redacted \d+ chars»$/);
    expect(message.text).toContain(KEY);
  });

  it("redacts only the messages that are new since the last save", () => {
    const local = storage();
    const kept = [1, 2, 3].map((i): Message => ({ id: `m${i}`, at: i, role: "bot", kind: "text", text: `step ${i} ${KEY}` }));
    writeSnapshotCache({ bots: [bot(kept)], groups: [], selectedId: "b1" }, local);
    redactions.count = 0;
    const fresh: Message = { id: "m4", at: 4, role: "bot", kind: "text", text: `step 4 ${KEY}` };
    writeSnapshotCache({ bots: [bot([...kept, fresh])], groups: [], selectedId: "b1" }, local);
    // a save lands a beat after every chat open, inside the first scroll
    expect(redactions.count).toBe(1);
    expect(local.getItem(SNAPSHOT_CACHE_KEY)).not.toContain(KEY);
    expect(readSnapshotCache(local)?.bots[0].messages.map((m) => m.text?.replace(/\d+ chars/, "n chars"))).toEqual([1, 2, 3, 4].map((i) => `step ${i} «redacted n chars»`));
  });

  it("keeps the profile for the next paint and drops a malformed one", () => {
    const local = storage();
    const profile = { name: "Ada", email: "", avatarUrl: "/api/attachments/ada.png" };
    writeSnapshotCache({ bots: [], groups: [], selectedId: "", profile }, local);
    expect(readSnapshotCache(local)?.profile).toEqual(profile);
    local.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ bots: [], groups: [], selectedId: "", profile: { name: 7 } }));
    expect(readSnapshotCache(local)).toBeNull();
  });

  it("drops an old unredacted cache on read", () => {
    const local = storage();
    const message: Message = { id: "m1", at: 1, role: "user", kind: "text", text: KEY };
    local.setItem("omb-snapshot", JSON.stringify({ bots: [bot([message])], groups: [], selectedId: "b1" }));
    expect(readSnapshotCache(local)).toBeNull();
    expect(local.getItem("omb-snapshot")).toBeNull();
  });
});
