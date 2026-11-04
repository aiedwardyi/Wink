// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { NotedLines } from "./MemoryGroups";
import { MemoryCleanRow } from "./MemoryCleanRow";
import { MemoryTidyLine } from "./MemoryTidyLine";
import { MemoryCleanIcon } from "./MemoryCleanMotion";
import { noteMemoryFrame } from "@/lib/memory-clean-events";

const store = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => store }));
const run = { runId: "r", at: new Date(2026, 10, 4).getTime(), files: ["MEMORY.md" as const], beforeBytes: 23757, afterBytes: 16388, merged: 5, replaced: 4, moved: 20, undoneAt: null, undoable: true };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
async function mount(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(node));
}
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove();
  applyLocale("en"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("cleanup copy", () => {
  it.each(["en", "ko"] as const)("keeps all parts in %s and sizes only in the tab", async (locale) => {
    applyLocale(locale);
    await mount(createElement(MemoryCleanRow, { run, onUndo: vi.fn() }));
    expect(host.textContent).toContain(locale === "en" ? "Tidied Nov 4: 23 to 16 KB, nothing lost" : "11월 4일 정리: 23KB에서 16KB로, 빠진 내용 없음");
    for (const part of locale === "en" ? ["5 merged", "4 replaced by newer", "20 moved to memory-history.md"] : ["5줄 합침", "4줄 최신으로 교체", "20줄 memory-history.md로 이동"]) expect(host.textContent).toContain(part);
    expect(host.querySelector(".whitespace-nowrap")?.textContent).toContain(locale === "en" ? "Undo" : "되돌리기");
    await act(async () => root.render(createElement(MemoryTidyLine, { tidy: { runId: "r" }, run, onUndo: vi.fn() })));
    expect(host.textContent).not.toContain("KB");
    expect(host.textContent).toContain(locale === "en" ? "Tidied memory, nothing lost" : "메모리 정리됨, 빠진 내용 없음");
    await act(async () => host.querySelector("button")!.click());
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, memory: { cleanup: true } });
  });
  it("uses decimals when rounded KB are equal and omits zero parts", async () => {
    await mount(createElement(MemoryCleanRow, { run: { ...run, beforeBytes: 1160, afterBytes: 1050, merged: 0, replaced: 0 }, onUndo: vi.fn() }));
    expect(host.textContent).toContain("1.1 to 1.0 KB");
    expect(host.textContent).not.toContain("merged");
    expect(host.textContent).not.toContain("replaced");
  });
  it("shows Undo only for the matching undoable run, and becomes inert after Undo", async () => {
    await mount(createElement(MemoryTidyLine, { tidy: { runId: "old" }, run, onUndo: vi.fn() }));
    expect(host.querySelectorAll("button")).toHaveLength(1);
    await act(async () => root.render(createElement(MemoryTidyLine, { tidy: { runId: "r", undoneAt: 1 }, run, onUndo: vi.fn() })));
    expect(host.textContent).toBe("Memory cleanup undone");
    expect(host.querySelector("button")).toBeNull();
    await act(async () => root.render(createElement(MemoryCleanRow, { run: { ...run, undoneAt: 1 }, onUndo: vi.fn() })));
    expect(host.textContent).toBe("Memory cleanup undone");
  });
});

describe("memory motion", () => {
  it("extends Recent to an older target and leaves a missing target untinted", async () => {
    const text = Array.from({ length: 8 }, (_, i) => `- Fact ${i} (noted 2026-11-0${i + 1})`).join("\n");
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    await mount(createElement(NotedLines, { text, target: { target: { line: "- Fact 0 (noted 2026-11-01)" }, nonce: 1 } }));
    expect(host.querySelectorAll("li.mc-target")).toHaveLength(8);
    expect(host.querySelector(".mc-tint")?.parentElement?.textContent).toContain("Fact 0");
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
    await act(async () => root.render(createElement(NotedLines, { text, target: { target: { line: "gone" }, nonce: 2 } })));
    expect(host.querySelector(".mc-tint")).toBeNull();
  });
  it("does not fade an existing line again when it is saved", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    await mount(createElement(NotedLines, { text: "- Existing (noted 2026-11-04)", botId: "existing", active: true }));
    await act(async () => noteMemoryFrame({ kind: "message", threadId: "e", message: { id: "again", tool: { name: "memory.save", lines: ["- Existing (noted 2026-11-04)"] } } }, { hydrated: true, bots: [{ id: "existing", threadId: "e", messages: [] }] }));
    expect(host.querySelector(".mc-in")).toBeNull();
  });
  it("never ripples on hydrate, replay or sync, and coalesces live saves", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    await mount(createElement(MemoryCleanIcon, { botId: "bot", active: true }));
    const message = { id: "new", at: Date.now(), role: "bot", kind: "activity", tool: { name: "memory.save", lines: ["- New"] } } as const;
    const bots = [{ id: "bot", threadId: "thread", messages: [] }];
    for (const frame of [{ kind: "hydrate", message }, { kind: "message", replayed: true, message }, { kind: "message", imported: true, message }]) {
      await act(async () => noteMemoryFrame({ ...frame, threadId: "thread" }, { hydrated: true, bots }));
      expect(host.querySelector(".mc-ripple")).toBeNull();
    }
    await act(async () => noteMemoryFrame({ kind: "message", threadId: "thread", message }, { hydrated: true, bots }));
    const ring = host.querySelector(".mc-ripple"); expect(ring).not.toBeNull();
    await act(async () => noteMemoryFrame({ kind: "message", threadId: "thread", message: { ...message, id: "new2" } }, { hydrated: true, bots }));
    expect(host.querySelector(".mc-ripple")).toBe(ring);
    await act(async () => ring!.dispatchEvent(new Event("animationend", { bubbles: true })));
    expect(host.querySelector(".mc-ripple")).toBeNull();
  });
  it("has no ripple in reduced motion and removes a still tint after two seconds", async () => {
    vi.useFakeTimers(); vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await mount(createElement(NotedLines, { text: "- Seoul (noted 2026-11-04)", target: { target: { line: "Seoul" }, nonce: 1 } }));
    expect(host.querySelector(".mc-tint")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.querySelector(".mc-tint")).toBeNull();
  });
});
