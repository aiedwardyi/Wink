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
import type { DreamFix } from "@/lib/memory-clean";

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
  it.each(["en", "ko"] as const)("keeps all parts in %s without sizes", async (locale) => {
    applyLocale(locale);
    await mount(createElement(MemoryCleanRow, { run, onUndo: vi.fn() }));
    expect(host.textContent).toContain(locale === "en" ? "Tidied Nov 4, nothing lost" : "11월 4일 정리, 빠진 내용 없음");
    expect(host.textContent).not.toContain("KB");
    for (const part of locale === "en" ? ["5 merged", "4 replaced by newer", "20 archived to memory/dreamed.md, still searchable"] : ["5줄 합침", "4줄 최신으로 교체", "20줄 memory/dreamed.md에 보관, 계속 검색돼요"]) expect(host.textContent).toContain(part);
    expect(host.querySelector(".whitespace-nowrap")?.textContent).toContain(locale === "en" ? "Undo" : "되돌리기");
    await act(async () => root.render(createElement(MemoryTidyLine, { bot: "Ava", tidy: { runId: "r", count: 3 }, run, onUndo: vi.fn() })));
    expect(host.textContent).not.toContain("KB");
    expect(host.textContent).toContain(locale === "en" ? "Ava: archived 3 old lines (still searchable). · Undo" : "Ava: 오래된 줄 3개 보관함 (계속 검색돼요). · 되돌리기");
    await act(async () => host.querySelector("button")!.click());
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, memory: { cleanup: true } });
  });
  it("keeps the details open to a dry run whose to-do checks did not finish", async () => {
    const dream = { mode: "dry" as const, notes: { state: "checked" as const, items: [] }, asks: { threads: 2, skipped: 1, unchecked: 2, items: [] }, runUntil: run.at, dropUntil: run.at };
    await mount(createElement(MemoryCleanRow, { run: { ...run, dream }, onUndo: vi.fn() }));
    expect(host.textContent).not.toContain("Nothing to move or close");
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("1 busy chats not checked.");
    expect(host.textContent).toContain("2 to-dos' PRs not checked yet.");
  });
  it("lists a fix with the owner's words, OK on a waiting one, Undo on a done one, none on a rule", async () => {
    const onFix = vi.fn();
    const fix = (target: string, extra: Partial<DreamFix> = {}) => ({ op: "fix" as const, target, text: "- Plan ends in January (noted 2026-11-20)", by: "- Plan ends in March (noted 2026-11-20)", why: "wrong" as const, listOnly: false, evidence: { thread: "t", message: "m", at: new Date(2026, 10, 24).getTime(), quote: "It lasts till march" }, ...extra });
    const items = [fix("note:a"), fix("note:b", { listOnly: true }), fix("note:c", { done: { at: 1, line: 3, cr: false, nth: 0, count: 1, heading: "", id: "x" } }), fix("note:d", { done: { at: 1, line: 3, cr: false, nth: 0, count: 1, heading: "", id: "y", undoneAt: 2 } })];
    const dream = { mode: "dry" as const, notes: { state: "checked" as const, items: [] }, asks: { threads: 1, skipped: 0, unchecked: 0, items: [] }, fixes: { state: "checked" as const, through: run.at, items }, runUntil: run.at, dropUntil: run.at };
    await mount(createElement(MemoryCleanRow, { run: { ...run, dream }, onUndo: vi.fn(), onFix }));
    expect(host.textContent).toContain("Would move 0 notes, fix 2 notes and close 0 to-dos.");
    await act(async () => host.querySelector("button")!.click());
    const lines = [...host.querySelectorAll("li")].map((li) => li.textContent);
    expect(lines[0]).toBe('Fix note "Plan ends in January (noted 2026-11-20)": you wrote on Nov 24: "It lasts till march". New note: "Plan ends in March (noted 2026-11-20)". · OK');
    expect(lines[1]).toContain("change it by hand if you agree.");
    expect(lines[2]).toContain("Fixed. The old note is in memory/dreamed.md, still searchable. · Undo");
    expect(lines[3]).toContain("Fix undone.");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("li button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["OK", "Undo"]);
    await act(async () => buttons[0]!.click());
    await act(async () => buttons[1]!.click());
    expect(onFix.mock.calls).toEqual([["note:a", false], ["note:c", true]]);
  });
  it.each(["en", "ko"] as const)("says an OK'd fix tidied the notes in %s, and a dry run with none changed nothing", async (locale) => {
    applyLocale(locale);
    const fix = { op: "fix" as const, target: "note:a", text: "- Plan ends in January (noted 2026-11-20)", by: "- Plan ends in March (noted 2026-11-20)", why: "wrong" as const, listOnly: false, evidence: { thread: "t", message: "m", at: new Date(2026, 10, 24).getTime(), quote: "It lasts till march" } };
    const done = { at: new Date(2026, 10, 26, 9).getTime(), line: 3, cr: false, nth: 0, count: 1, heading: "", id: "x" };
    const dream = (items: DreamFix[]) => ({ mode: "dry" as const, notes: { state: "checked" as const, items: [] }, asks: { threads: 1, skipped: 0, unchecked: 0, items: [] }, fixes: { state: "checked" as const, through: run.at, items }, runUntil: run.at, dropUntil: run.at });
    const [tidied, unchanged] = locale === "en" ? ["Tidied Nov 26, nothing lost", "Nothing changed."] : ["11월 26일 정리, 빠진 내용 없음", "바뀐 것 없음."];
    await mount(createElement(MemoryCleanRow, { run: { ...run, dream: dream([{ ...fix, done }]) }, onUndo: vi.fn() }));
    expect(host.textContent).toContain(tidied);
    expect(host.textContent).not.toContain(unchanged);
    await act(async () => root.render(createElement(MemoryCleanRow, { run: { ...run, dream: dream([fix, { ...fix, target: "note:b", done: { ...done, undoneAt: done.at + 1 } }]) }, onUndo: vi.fn() })));
    expect(host.textContent).toContain(unchanged);
    expect(host.textContent).not.toContain(tidied);
  });
  it("omits zero-count details", async () => {
    await mount(createElement(MemoryCleanRow, { run: { ...run, merged: 0, replaced: 0 }, onUndo: vi.fn() }));
    expect(host.textContent).not.toContain("merged");
    expect(host.textContent).not.toContain("replaced");
  });
  it.each(["en", "ko"] as const)("words a line saved before it counted its lines without a number in %s", async (locale) => {
    applyLocale(locale);
    await mount(createElement(MemoryTidyLine, { bot: "Ava", tidy: { runId: "old" }, run, onUndo: vi.fn() }));
    expect(host.textContent).not.toContain("undefined");
    expect(host.textContent).toBe(locale === "en" ? "Tidied memory, nothing lost" : "메모리 정리됨, 빠진 내용 없음");
  });
  it("shows Undo only for the matching undoable run, and becomes inert after Undo", async () => {
    await mount(createElement(MemoryTidyLine, { bot: "Ava", tidy: { runId: "old", count: 1 }, run, onUndo: vi.fn() }));
    expect(host.querySelectorAll("button")).toHaveLength(1);
    await act(async () => root.render(createElement(MemoryTidyLine, { bot: "Ava", tidy: { runId: "r", count: 1, undoneAt: 1 }, run, onUndo: vi.fn() })));
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
    for (const frame of [{ kind: "hydrate", message }, { kind: "message", replayed: true, message }, { kind: "message", imported: true, message }, { kind: "memory.changed", botId: "bot" }]) {
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
