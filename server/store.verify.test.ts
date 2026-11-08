import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import type { VerifyCardData } from "../shared/live-verify.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

const card = (patch: Partial<VerifyCardData> = {}): VerifyCardData => ({
  v: 1, runId: "0b6f3c1e-8a2d-4c1f-9e7a-5d4b3a2c1f0e", owner: "bot_7Hq2", site: "site/index.html", status: "completed", mode: "ask",
  decisionNonce: "4f9a0c2e7b1d", offeredAt: 1_000, startedAt: 2_000, endedAt: 24_400,
  counts: { planned: 22, completed: 22, passed: 20, failed: 2, blocked: 0, notRun: 0 },
  issues: [
    { checker: "CONTRAST", tile: "phone", rule: "contrast", where: "p.lede", measured: "3.1:1, needs 4.5:1", scrollY: 640 },
    { checker: "LINKS", tile: "desktop", rule: "dead link", where: "a[href='/pricing']", measured: "404" },
  ],
  issueTotal: 2,
  ...patch,
});

describe("verify card messages", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("survive a save and reload unchanged", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const row = store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "Live Verify: site/index.html", verify: card({ status: "running", counts: undefined, issues: undefined, issueTotal: undefined }), origin: "device-1" });
    store.patchMessage(bot.threadId, row.id, { verify: card() });
    closeMessageDb();
    const reloaded = new Store(selection).messagesFor(bot.threadId).find((message) => message.id === row.id);
    expect(reloaded?.verify).toEqual(card());
    expect(reloaded?.origin).toBe("device-1");
  });

  it("stay bounded and scrubbed", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const issue = { checker: "FIT", tile: "desktop", rule: `r${"x".repeat(200)}`, where: `w ${key} ${"y".repeat(200)}`, measured: "m".repeat(400) } as const;
    const row = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "note",
      text: "Live Verify",
      verify: card({ site: `${key}/${"s".repeat(2_000)}`, issues: Array.from({ length: 55 }, () => ({ ...issue })), issueTotal: 55 }),
    });
    closeMessageDb();
    const verify = new Store(selection).messagesFor(bot.threadId).find((message) => message.id === row.id)?.verify;
    expect(JSON.stringify(verify)).not.toContain(key);
    expect(verify?.site.length).toBeLessThanOrEqual(1_024);
    expect(verify?.issues).toHaveLength(40);
    expect(verify?.issueTotal).toBe(55);
    for (const kept of verify!.issues!) {
      expect(kept.rule.length).toBeLessThanOrEqual(80);
      expect(kept.where.length).toBeLessThanOrEqual(120);
      expect(kept.measured.length).toBeLessThanOrEqual(160);
    }
  });

  it("drop a malformed payload and unknown fields", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const bad = store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "x", verify: { ...card(), runId: "../../etc" } });
    const extra = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "note",
      text: "y",
      verify: { ...card(), grant: "orbit-verify-v1.secret", issues: [{ checker: "NOPE", tile: "phone", rule: "r", where: "w", measured: "m" }] } as unknown as VerifyCardData,
    });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === bad.id)?.verify).toBeUndefined();
    const kept = store.messagesFor(bot.threadId).find((m) => m.id === extra.id)?.verify;
    expect(kept).not.toHaveProperty("grant");
    expect(kept?.issues).toEqual([]);
  });
});
