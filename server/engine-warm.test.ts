import { describe, expect, it, vi } from "vitest";

import { createWarmPool } from "./drivers/warm-pool.ts";
import { createRequestQuiet, createSignInWarm, oneEngine, warmEngines } from "./engine-warm.ts";

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
      ["muse", { enabled: true, driverKind: "museAgent", prepare: prepare("muse") }],
      ["grok", { enabled: true, driverKind: "museAgent", prepare: prepare("grok") }],
      ["claude", { enabled: true, driverKind: "museAgent", prepare: prepare("claude") }],
      ["codex", { enabled: true, driverKind: "museAgent", prepare: undefined }],
      ["gemini", { enabled: false, driverKind: "museAgent", prepare: prepare("gemini") }],
      ["kimi", { enabled: true, driverKind: "museAgent", prepare: prepare("kimi") }],
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
      instance: () => ({ enabled: true, driverKind: "museAgent", prepare }),
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
      instance: (id) => ({ enabled: true, driverKind: "museAgent", prepare: id === "muse" ? async () => { throw new Error("spawn failed"); } : good }),
      busy: () => false,
    });
    expect(warmed).toEqual(["grok"]);
    expect(good).toHaveBeenCalledOnce();
  });
});

describe("createSignInWarm", () => {
  it("warms a wanted engine once when it signs in after boot, with no model request", async () => {
    const prepare = vi.fn(async () => {});
    const generateText = vi.fn(async () => "");
    const warm = createSignInWarm({
      wanted: async () => new Set(["muse"]),
      instance: () => ({ enabled: true, driverKind: "museAgent", prepare, generateText }),
      busy: () => false,
    });
    expect(warm.observe([row("muse", "available", false)])).toBeUndefined();
    warm.arm([row("muse", "available", false), row("grok", "available", false)]);
    expect(warm.observe([row("muse", "available", false), row("grok", "available", false)])).toBeUndefined();
    await warm.observe([row("muse"), row("grok")]);
    expect(warm.observe([row("muse"), row("grok")])).toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("leaves engines warmed at boot alone and warms again after a fresh sign-in", async () => {
    const prepare = vi.fn(async () => {});
    const warm = createSignInWarm({
      wanted: async () => new Set(["muse"]),
      instance: () => ({ enabled: true, driverKind: "museAgent", prepare }),
      busy: () => false,
    });
    warm.arm([row("muse")]);
    expect(warm.observe([row("muse")])).toBeUndefined();
    expect(warm.observe([row("muse", "available", false)])).toBeUndefined();
    await warm.observe([row("muse")]);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("runs one sign-in warm at a time", async () => {
    let open = 0;
    let most = 0;
    const prepare = vi.fn(async () => {
      most = Math.max(most, ++open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
    });
    const warm = createSignInWarm({
      wanted: async () => new Set(["muse", "grok"]),
      instance: () => ({ enabled: true, driverKind: "museAgent", prepare }),
      busy: () => false,
    });
    warm.arm([]);
    const first = warm.observe([row("muse")]);
    expect(await Promise.all([first, warm.observe([row("grok")])])).toEqual([["muse"], ["grok"]]);
    expect(most).toBe(1);
  });
});

describe("createRequestQuiet", () => {
  it("holds a warm until no request is open and the last one ended 2 s ago", async () => {
    let now = 0;
    const quiet = createRequestQuiet(() => now, 2_000);
    const done = quiet.track();
    const prepare = vi.fn(async () => {});
    const seen: boolean[] = [];
    const wait = vi.fn(async () => {
      seen.push(prepare.mock.calls.length > 0);
      if (wait.mock.calls.length === 1) { now = 5_000; done(); done(); }
      else if (wait.mock.calls.length === 2) { now = 6_000; quiet.track()(); }
      else now += 5_000;
    });
    const warmed = await warmEngines({
      rows: [row("muse")],
      wanted: new Set(["muse"]),
      instance: () => ({ enabled: true, driverKind: "museAgent", prepare }),
      busy: () => false,
      settled: quiet.settled,
      wait,
      now: () => now,
    });
    expect(warmed).toEqual(["muse"]);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([false, false, false]);
    expect(prepare).toHaveBeenCalledOnce();
  });
});

describe("no-intent warm gates", () => {
  const GiB = 1024 ** 3;
  const warmOn = async (pool: ReturnType<typeof createWarmPool>) => {
    const prepare = vi.fn(async () => {});
    await warmEngines({
      rows: [row("muse")],
      wanted: new Set(["muse"]),
      instance: () => ({ enabled: true, driverKind: "museAgent", prepare }),
      busy: () => false,
      admit: (kind) => pool.idleWarmAllowed(kind),
    });
    return prepare.mock.calls.length;
  };

  it("spawns nothing on a small PC or under the RAM floor", async () => {
    expect(await warmOn(createWarmPool({ totalmem: () => 4 * GiB, freemem: () => 3 * GiB, cpus: () => 8 }))).toBe(0);
    expect(await warmOn(createWarmPool({ totalmem: () => 32 * GiB, freemem: () => 16 * GiB, cpus: () => 4 }))).toBe(0);
    expect(await warmOn(createWarmPool({ totalmem: () => 32 * GiB, freemem: () => 2 * GiB, cpus: () => 16 }))).toBe(0);
    expect(await warmOn(createWarmPool({ totalmem: () => 32 * GiB, freemem: () => 16 * GiB, cpus: () => 16 }))).toBe(1);
  });

  it("starts a capped wait at the first moment no request is open", () => {
    let now = 0;
    const quiet = createRequestQuiet(() => now, 2_000, 30_000);
    let open: (() => void) | undefined;
    for (; now < 40_000; now += 1_000) {
      open?.();
      open = quiet.track();
      expect(quiet.settled(0)).toBe(false);
      if (now >= 30_000) {
        open();
        open = undefined;
        expect(quiet.settled(0)).toBe(true);
      } else {
        now += 500;
        open();
        open = undefined;
        expect(quiet.settled(0)).toBe(false);
        now -= 500;
      }
    }
  });

  it("picks the most recently used chat's engine, else the default", () => {
    expect(oneEngine([{ instanceId: "grok", at: 5 }, { instanceId: "muse", at: 9 }, { instanceId: "claude", at: null }], "codex")).toEqual(new Set(["muse"]));
    expect(oneEngine([{ instanceId: "grok", at: null }], "muse")).toEqual(new Set(["muse"]));
    expect(oneEngine([], "muse")).toEqual(new Set(["muse"]));
  });
});
