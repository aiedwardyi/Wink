// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

import { MemorySaveChip, MemorySaveRun } from "./MemorySaveChip";

const store = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => store }));

const NOW = 1_800_000_000_000;

async function renderChip(at: number) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MemorySaveChip, { summary: "likes short replies", at })));
  return { host, root };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("MemorySaveChip", () => {
  it("shows an earlier save as saved on mount, without replaying Saving to memory", async () => {
    const { host, root } = await renderChip(NOW - 60_000);
    try {
      expect(host.textContent).toContain("likes short replies");
      expect(host.textContent).not.toContain("Saving to memory");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the tap target flat with rounded corners", async () => {
    const { host, root } = await renderChip(NOW - 60_000);
    try {
      const cls = new Set(host.querySelector("span")!.parentElement!.className.split(/\s+/));
      expect(cls.has("border-transparent")).toBe(true);
      expect([...cls].filter((c) => /^(bg-|border-hairline)/.test(c))).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("flickers Saving to memory for a save that just landed", async () => {
    const { host, root } = await renderChip(NOW);
    try {
      expect(host.textContent).toContain("Saving to memory");
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(host.textContent).toContain("likes short replies");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("MemorySaveRun", () => {
  const note = (id: string, at: number): Message => ({ id, at, role: "bot", kind: "activity", tool: { name: "memory.save", spoken: id, ok: true } });

  async function renderRun(ats: number[]) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const messages = ats.map((at, i) => note(`n${i}`, at));
    await act(async () => root.render(createElement(MemorySaveRun, { messages, children: createElement("i", null, "notes") })));
    return { host, root };
  }

  it("draws the folded row flat, like the single save", async () => {
    const { host, root } = await renderRun([NOW - 60_000, NOW - 59_000]);
    try {
      const button = host.querySelector("button")!;
      const cls = new Set(button.className.split(/\s+/));
      expect(cls.has("border-transparent")).toBe(true);
      expect([...cls].filter((c) => /^(bg-|border-hairline|rounded-(full|2xl))/.test(c))).toEqual([]);
      expect(button.textContent).toBe("Memory updated · 2 notes");
      expect(button.querySelector("svg.lucide-brain")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("flickers again when the run grows live, then counts the new note", async () => {
    const { host, root } = await renderRun([NOW - 60_000, NOW - 59_000]);
    try {
      const messages = [NOW - 60_000, NOW - 59_000, NOW].map((at, i) => note(`n${i}`, at));
      await act(async () => root.render(createElement(MemorySaveRun, { messages, children: createElement("i", null, "notes") })));
      expect(host.querySelector("button")!.textContent).toBe("Saving to memory…");
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(host.querySelector("button")!.textContent).toBe("Memory updated · 3 notes");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("flickers Saving to memory while the newest save is inside the window, then counts", async () => {
    const { host, root } = await renderRun([NOW - 60_000, NOW]);
    try {
      expect(host.querySelector("button")!.textContent).toBe("Saving to memory…");
      expect(host.querySelector("button svg.animate-spin")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(host.querySelector("button")!.textContent).toBe("Memory updated · 2 notes");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  applyLocale("en");
  vi.clearAllMocks();
});
async function mount(props: Parameters<typeof MemorySaveChip>[0]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(MemorySaveChip, props)));
}

describe("memory chip", () => {
  it("uses a muted brain and dispatches the line matching its summary", async () => {
    await mount({ summary: "Lives in Seoul", at: 1, lines: ["- Other", "- Lives in Seoul (noted 2026-11-04)"] });
    expect(host.querySelector(".lucide-brain")).not.toBeNull();
    expect(host.querySelector(".lucide-check, .text-success")).toBeNull();
    const button = host.querySelector("button")!;
    expect(button.type).toBe("button");
    await act(async () => button.click());
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, memory: { line: "- Lives in Seoul (noted 2026-11-04)" } });
  });
  it("falls back to the first line or an older summary", async () => {
    await mount({ summary: "Old...", at: 1 });
    await act(async () => host.querySelector("button")!.click());
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, memory: { line: "Old..." } });
  });
  it("keeps a room chip inert", async () => {
    await mount({ summary: "Room note", at: 1, room: true });
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector(".lucide-brain")).not.toBeNull();
    expect(store.dispatch).not.toHaveBeenCalled();
  });
  it("uses the brain on a folded run and buttons inside it", async () => {
    await mount({ summary: "One", at: 1 });
    const messages = [1, 2].map((at) => ({ id: String(at), at, role: "bot" as const, kind: "activity" as const }));
    await act(async () => root.render(createElement(MemorySaveRun, { messages, forceOpen: true, children: createElement(MemorySaveChip, { summary: "One", at: 1 }) })));
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(host.querySelectorAll(".lucide-brain")).toHaveLength(2);
  });
});
