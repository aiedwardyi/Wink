import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function storage(saved: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved[key] ?? null, setItem: (key: string, value: string) => { saved[key] = value; } });
  return saved;
}

describe("call volume", () => {
  it("is full until this device picks one, then remembers it", async () => {
    const saved = storage();
    const first = await import("./volume");
    expect(first.callVolume()).toBe(1);
    first.setCallVolume(0.4);
    expect(saved["omb-call-volume"]).toBe("0.4");
    vi.resetModules();
    expect((await import("./volume")).callVolume()).toBe(0.4);
  });

  it("never goes silent or past full", async () => {
    storage({ "omb-call-volume": "7" });
    const volume = await import("./volume");
    expect(volume.callVolume()).toBe(1);
    volume.setCallVolume(0);
    expect(volume.callVolume()).toBe(0.1);
  });
});
