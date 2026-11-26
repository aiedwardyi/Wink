import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, loadConfig, parseConfigPatch, saveConfig } from "./config.ts";
import { nextUsageOrder, parseUsageOrderBody, usageOrderStatus } from "./usage-order.ts";

const drag = (key: string, order: string[]) => parseUsageOrderBody({ key, order });
const seed = (orders: Record<string, string[]>, from: "desktop" | "browser") => parseUsageOrderBody({ seed: orders, from });

describe("usage order Wink keeps for every client", () => {
  it("sets one dragged list and keeps the others", () => {
    const saved = nextUsageOrder({ orders: { claude: ["a", "b"], engines: ["claude", "codex"] } }, drag("claude", ["b", "a", "b"]));
    expect(saved).toEqual({ orders: { claude: ["b", "a"], engines: ["claude", "codex"] }, rev: 1 });
  });

  it("takes a client's old local order only when Wink has none", () => {
    expect(nextUsageOrder(undefined, seed({ claude: ["b", "a"] }, "desktop"))).toEqual({ orders: { claude: ["b", "a"] }, rev: 1 });
    expect(nextUsageOrder({ orders: { claude: ["a", "b"] } }, seed({ claude: ["b", "a"] }, "desktop"))).toBeNull();
    expect(nextUsageOrder({ orders: { claude: ["a", "b"] } }, seed({ claude: ["b", "a"] }, "browser"))).toBeNull();
  });

  it("lets the desktop app's old order replace one a browser sent first, until a drag", () => {
    const phone = nextUsageOrder(undefined, seed({ claude: ["c", "a"] }, "browser"));
    expect(phone).toEqual({ orders: { claude: ["c", "a"] }, seed: "browser", rev: 1 });
    expect(nextUsageOrder(phone!, seed({ claude: ["x"] }, "browser"))).toBeNull();
    expect(nextUsageOrder(phone!, seed({ claude: ["b", "a"] }, "desktop"))).toEqual({ orders: { claude: ["b", "a"] }, rev: 2 });
    const dragged = nextUsageOrder(phone!, drag("claude", ["a", "c"]));
    expect(dragged).toEqual({ orders: { claude: ["a", "c"] }, rev: 2 });
    expect(nextUsageOrder(dragged!, seed({ claude: ["b", "a"] }, "desktop"))).toBeNull();
  });

  it.each([
    {},
    { key: "claude" },
    { key: "claude", order: [1] },
    { key: "", order: [] },
    { key: "claude", order: [], extra: true },
    { seed: { claude: "a" }, from: "desktop" },
    { seed: {}, from: "phone" },
  ])("refuses a malformed request %j", (body) => {
    expect(() => parseUsageOrderBody(body)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("reports null until an order is saved", () => {
    expect(usageOrderStatus(undefined)).toBeNull();
  });
});

describe("usage order in config.json", () => {
  const path = join(DATA_DIR, "config.json");
  let before: string | null;
  beforeEach(() => { before = existsSync(path) ? readFileSync(path, "utf8") : null; });
  afterEach(() => { if (before === null) rmSync(path, { force: true }); else writeFileSync(path, before); });

  it("survives a reload and other settings saves", () => {
    saveConfig({ usageOrder: { orders: { claude: ["b", "a"] } } });
    saveConfig(parseConfigPatch({ features: { showToolCalls: true } }));
    expect(loadConfig().usageOrder).toEqual({ orders: { claude: ["b", "a"] } });
  });

  it("is written only by its own route, never by a settings patch", () => {
    expect(parseConfigPatch({ features: { showToolCalls: true }, usageOrder: { orders: { claude: ["x"] } } } as never)).not.toHaveProperty("usageOrder");
  });

  it("drops a damaged saved order instead of the whole config", () => {
    writeFileSync(path, JSON.stringify({ rooms: { turnTimeoutMinutes: 30 }, usageOrder: { orders: { claude: "a" } } }));
    const loaded = loadConfig();
    expect(loaded.usageOrder).toBeUndefined();
    expect(loaded.rooms?.turnTimeoutMinutes).toBe(30);
  });
});
