// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { useMemoryClean } from "./memory-clean";

const run = { runId: "r", at: 1, files: ["MEMORY.md"], beforeBytes: 2000, afterBytes: 1000, merged: 1, replaced: 0, moved: 0, undoneAt: null, undoable: true };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let value: ReturnType<typeof useMemoryClean>;
const Probe = ({ messages = [], active = true }: { messages?: Message[]; active?: boolean }) => {
  value = useMemoryClean("b", messages, active);
  return null;
};
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
}
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove(); vi.unstubAllGlobals();
});

describe("cleanup summary", () => {
  it.each([false, true])("replaces an in-flight read when a tidy signature changes (patch %s)", async (patched) => {
    const replies: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve)));
    vi.stubGlobal("fetch", fetch);
    const message: Message = { id: "t", role: "bot", kind: "activity", at: 1, tool: { name: "memory.save", tidy: { runId: "r" } } };
    await mount();
    if (patched) {
      await act(async () => replies[0](Response.json({ run })));
      await act(async () => root.render(createElement(Probe, { messages: [message] })));
    }
    const before = replies.length;
    const changed = patched ? { ...message, tool: { ...message.tool!, tidy: { runId: "r", undoneAt: 3 } } } : message;
    await act(async () => root.render(createElement(Probe, { messages: [changed] })));
    const reads = replies.length;
    await act(async () => replies[before - 1](Response.json({ run: patched ? null : { ...run, runId: "stale" } })));
    expect(value.run?.runId).toBe(patched ? "r" : undefined);
    if (reads > before) await act(async () => replies[before](Response.json({ run: { ...run, undoneAt: patched ? 3 : null, undoable: !patched } })));
    expect(reads).toBe(before + 1);
    expect(value.run?.runId).toBe("r");
    expect(value.run?.undoable).toBe(!patched);
  });

  it("coalesces same-bot reads across cleanup rows and refetches after settling", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    await mount();
    await act(async () => root.render(createElement("div", null, createElement(Probe), createElement(Probe), createElement(Probe))));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => finish(Response.json({ run })));
    expect(value.run?.runId).toBe("r");
    await act(async () => root.render(createElement(Probe)));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => finish(Response.json({ run })));
  });

  it.each([false, true])("coalesces replacement reads across mounted rows (patch %s)", async (patched) => {
    const replies: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve)));
    vi.stubGlobal("fetch", fetch);
    await mount();
    const message: Message = { id: "t", role: "bot", kind: "activity", at: 1, tool: { name: "memory.save", tidy: { runId: "r" } } };
    const rows = (messages: Message[]) => createElement("div", null, ...[1, 2, 3].map((key) => createElement(Probe, { key, messages })));
    await act(async () => root.render(rows(patched ? [message] : [])));
    await act(async () => replies[0](Response.json({ run })));
    const changed = patched ? { ...message, tool: { ...message.tool!, tidy: { runId: "r", undoneAt: 3 } } } : message;
    const before = replies.length;
    await act(async () => root.render(rows([changed])));
    const reads = replies.length - before;
    await act(async () => { for (const reply of replies.slice(before)) reply(Response.json({ run: { ...run, undoable: !patched } })); });
    expect(reads).toBe(1);
    expect(value.run?.undoable).toBe(!patched);
  });

  it("refreshes after Undo even when an older summary is in flight", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ run }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json({ ok: true, revision: "new", restored: 1, skipped: 0 }))
      .mockResolvedValueOnce(Response.json({ run: { ...run, undoneAt: 3, undoable: false } }));
    vi.stubGlobal("fetch", fetch); await mount();
    await act(async () => root.render(createElement(Probe, { active: false })));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => value.undo());
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => finish(Response.json({ run })));
    expect(value.run?.undoable).toBe(false);
    expect(value.run?.undoneAt).toBe(3);
  });

  it("refetches on tab reopen and a tidy append or patch", async () => {
    const fetch = vi.fn(async () => Response.json({ run })); vi.stubGlobal("fetch", fetch);
    await mount(); expect(value.run?.runId).toBe("r");
    await act(async () => root.render(createElement(Probe, { active: false })));
    await act(async () => root.render(createElement(Probe, { active: true })));
    const message: Message = { id: "t", role: "bot", kind: "activity", at: 1, tool: { name: "memory.save", tidy: { runId: "r" } } };
    await act(async () => root.render(createElement(Probe, { messages: [message] })));
    await act(async () => root.render(createElement(Probe, { messages: [{ ...message, tool: { ...message.tool!, tidy: { runId: "r", undoneAt: 2 } } }] })));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("refetches a tidy append while the Memory tab is hidden", async () => {
    const fetch = vi.fn(async () => Response.json({ run })); vi.stubGlobal("fetch", fetch);
    await mount();
    await act(async () => root.render(createElement(Probe, { active: false })));
    const message: Message = { id: "t", role: "bot", kind: "activity", at: 1, tool: { name: "memory.save", tidy: { runId: "r" } } };
    await act(async () => root.render(createElement(Probe, { active: false, messages: [message] })));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([204, 404, 500])("hides the row on HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    await mount(); expect(value.run).toBeNull();
  });
  it("keeps Undo on busy, then hides it and refetches on another conflict", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ run })).mockResolvedValueOnce(Response.json({ ok: false, error: "busy" }, { status: 409 })).mockResolvedValueOnce(Response.json({ ok: false, error: "undone" }, { status: 409 })).mockResolvedValueOnce(Response.json({ run: { ...run, undoable: false, undoneAt: 3 } }));
    vi.stubGlobal("fetch", fetch); await mount();
    await act(async () => value.undo()); expect(value.run?.undoable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => value.undo()); expect(value.run?.undoable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ runId: "r" });
  });
  it("clears the summary after other Undo failures without refetching", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ run })).mockResolvedValueOnce(Response.json({ error: "failed" }, { status: 500 }));
    vi.stubGlobal("fetch", fetch); await mount();
    await act(async () => value.undo());
    expect(value.run).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("marks success undone and ignores a second click in flight", async () => {
    let finish: (response: Response) => void = () => {};
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ run })).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })).mockResolvedValueOnce(Response.json({ run: { ...run, undoneAt: 3, undoable: false } }));
    vi.stubGlobal("fetch", fetch); await mount();
    let pending: Promise<void>;
    await act(async () => { pending = value.undo(); void value.undo(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { finish(Response.json({ ok: true, revision: "new", restored: 1, skipped: 0 })); await pending; });
    expect(value.run?.undoneAt).toBe(3);
  });
});
