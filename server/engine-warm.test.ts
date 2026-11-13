import { describe, expect, it, vi } from "vitest";

import { warmEngines } from "./engine-warm.ts";

const row = (instanceId: string, state = "available", authenticated: boolean | undefined = true) => ({ instanceId, snapshot: { state, authenticated } });

describe("warmEngines", () => {
  it("warms only wanted, signed-in, enabled engines, one at a time", async () => {
    const order: string[] = [];
    let open = 0;
    const prepare = (id: string) => vi.fn(async () => {
      open++;
      expect(open).toBe(1);
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
    });
    const instances = new Map([
      ["muse", { enabled: true, prepare: prepare("muse") }],
      ["grok", { enabled: true, prepare: prepare("grok") }],
      ["claude", { enabled: true, prepare: prepare("claude") }],
      ["codex", { enabled: true, prepare: undefined }],
      ["gemini", { enabled: false, prepare: prepare("gemini") }],
      ["kimi", { enabled: true, prepare: prepare("kimi") }],
    ]);
    const warmed = await warmEngines({
      rows: [row("muse"), row("grok"), row("claude", "available", false), row("codex"), row("gemini"), row("kimi", "unavailable")],
      wanted: new Set(["muse", "grok", "claude", "codex", "gemini", "kimi"]),
      instance: (id) => instances.get(id) ?? null,
      busy: () => false,
    });
    expect(warmed).toEqual(["muse", "grok"]);
    expect(order).toEqual(["muse", "grok"]);
  });

  it("skips engines no bot uses and waits out live turns", async () => {
    const prepare = vi.fn(async () => {});
    let busy = 2;
    const wait = vi.fn(async () => { busy--; });
    const warmed = await warmEngines({
      rows: [row("grok"), row("muse")],
      wanted: new Set(["muse"]),
      instance: () => ({ enabled: true, prepare }),
      busy: () => busy > 0,
      wait,
    });
    expect(warmed).toEqual(["muse"]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("keeps going when one engine's warm fails", async () => {
    const good = vi.fn(async () => {});
    const warmed = await warmEngines({
      rows: [row("muse"), row("grok")],
      wanted: new Set(["muse", "grok"]),
      instance: (id) => ({ enabled: true, prepare: id === "muse" ? async () => { throw new Error("spawn failed"); } : good }),
      busy: () => false,
    });
    expect(warmed).toEqual(["grok"]);
    expect(good).toHaveBeenCalledOnce();
  });
});
