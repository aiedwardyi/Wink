// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { MemoryMap } from "./MemoryMap";

vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
const bot = { id: "b", threadId: "t", messages: [], tasks: [] } as unknown as Bot;
const text = "- Uses VS Code (noted 2026-10-29)\n- Freshman in CS (noted 2026-10-25)\n- Has ADHD (noted 2026-10-17)\n- Has Linux available (noted 2026-10-17)\n- Feedback style: lead with \"not quite\" (noted 2026-10-30)";
const topics = [{ name: "reps-content-preferences.md", bytes: 1135 }, { name: "interview-direction.md", bytes: 842 }];
const sleep = { sleptAt: new Date(2026, 10, 7, 3, 12), kept: 24, merged: 1, forgot: 1, learned: 3, onUndo: vi.fn() };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
async function mount(props: Partial<Parameters<typeof MemoryMap>[0]> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(MemoryMap, { bot, text, topics, active: true, ...props })));
}
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove();
  applyLocale("en");
});

describe("MemoryMap", () => {
  it("names each kind with its hint and count", async () => {
    await mount();
    const panel = (kind: string) => host.querySelector(`[data-kind="${kind}"]`)!.textContent;
    expect(panel("long")).toContain("Long-Term Memory");
    expect(panel("long")).toContain("Facts it keeps about you");
    expect(panel("long")).toContain("2facts");
    expect(panel("knowledge")).toContain("2files");
    expect(panel("muscle")).toContain("1lesson");
    expect(host.querySelector(".mm-live")!.textContent).toContain("Uses VS Code");
  });

  it("hides the Sleep line until Sleep has run", async () => {
    await mount();
    expect(host.querySelector(".mm-sleep")).toBeNull();
    expect(host.textContent).not.toContain("Slept");
  });

  it.each(["en", "ko"] as const)("shows last night's Sleep with Undo in %s", async (locale) => {
    applyLocale(locale);
    await mount({ sleep });
    const line = host.querySelector(".mm-sleep")!;
    expect(line.textContent).toContain(locale === "en" ? "Slept at 3:12" : "수면");
    expect(line.textContent).toContain(locale === "en" ? "kept24" : "유지24");
    await act(async () => line.querySelector("button")!.click());
    expect(sleep.onUndo).toHaveBeenCalled();
  });
});
