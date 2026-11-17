import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function storage(saved: Record<string, string> = {}, writable = true) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved[key] ?? null,
    setItem: (key: string, value: string) => {
      if (!writable) throw new Error("quota");
      saved[key] = value;
    },
  });
  return saved;
}

describe("call captions", () => {
  it("are on until this device turns them off, and a saved choice stays", async () => {
    const saved = storage();
    const captions = await import("./captions");
    expect(captions.callCaptions()).toBe(true);
    captions.setCallCaptions(false);
    expect(saved["wink.liveCall.captions"]).toBe("0");
    vi.resetModules();
    expect((await import("./captions")).callCaptions()).toBe(false);
    storage({ "wink.liveCall.captions": "1" });
    vi.resetModules();
    expect((await import("./captions")).callCaptions()).toBe(true);
  });

  it("keep the choice for the session when storage refuses the write", async () => {
    storage({}, false);
    const captions = await import("./captions");
    captions.setCallCaptions(false);
    expect(captions.callCaptions()).toBe(false);
    captions.setCallCaptions(true);
    expect(captions.callCaptions()).toBe(true);
  });
});
