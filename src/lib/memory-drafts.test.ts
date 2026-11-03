// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

// each import of a fresh module copy stands in for one browser tab
const tab = async () => {
  vi.resetModules();
  return import("./memory-drafts");
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it.each(["network", "gateway", "limit"])("uses plain words when autosave hits %s", async (failure) => {
  vi.useFakeTimers();
  const drafts = await tab();
  const failed = vi.fn();
  drafts.watchMemory("error", { saved: vi.fn(), conflict: vi.fn(), failed });
  drafts.openMemory("error", { text: "old", revision: "r0" });
  drafts.editMemory("error", "new");
  vi.stubGlobal("fetch", failure === "network"
    ? vi.fn().mockRejectedValue(new TypeError("Load failed"))
    : vi.fn().mockResolvedValue(new Response(failure === "gateway" ? "Bad Gateway" : JSON.stringify({ error: "memory is capped at 256KB - move longer notes into memory/<topic>.md files" }), { status: failure === "gateway" ? 502 : 400 })));
  await drafts.flushMemory("error");
  expect(failed).toHaveBeenCalledWith(failure === "limit" ? "Memory is full. Move some notes into separate memory files." : "Can't reach Wink. Check your connection.", false);
  expect(drafts.memoryDraft("error")).toBe("new");
});

it("never sends a save without a base revision", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const drafts = await tab();
  drafts.editMemory("no-read", "new note");
  await drafts.flushMemory("no-read");
  expect(fetch).not.toHaveBeenCalled();
  expect(drafts.memoryDraft("no-read")).toBe("new note");
});

it("keeps another tab's stored draft when this tab's save lands", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const a = await tab();
  const b = await tab();
  a.openMemory("two-tabs", { text: "base", revision: "r0" });
  b.openMemory("two-tabs", { text: "base", revision: "r0" });
  let finish: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => (finish = resolve)));
  a.editMemory("two-tabs", "tab A text");
  const flight = a.flushMemory("two-tabs");
  b.editMemory("two-tabs", "tab B text");
  finish(new Response(JSON.stringify({ revision: "r1", truncated: false })));
  await flight;
  expect(a.memoryDraft("two-tabs")).toBeNull();
  expect((await tab()).memoryDraft("two-tabs")).toBe("tab B text");
});
