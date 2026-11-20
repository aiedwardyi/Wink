// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { Bot } from "@/state/store";

import { landFold, spyReveal } from "./Fold.test-land";
import { MemoryAsks } from "./MemoryAsks";

let host: HTMLDivElement;
let root: Root;

// SAFETY: MemoryAsks reads only the bot's task records.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial Bot, as MemoryMap.test builds it.
const bot = { tasks: [{ taskState: { updatedAt: 1, asks: [
  { text: "Pick a name", at: 1, status: "open" },
  { text: "Shorten the intro", at: 2, status: "done" },
  { text: "Drop the footer", at: 3, status: "declined" },
] } }] } as unknown as Bot;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("omb-locale", "en");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("brings the first done ask into view once the list has opened, never while closing", async () => {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(MemoryAsks, { bot }))));
  const scrolled = spyReveal();
  try {
    const toggle = () => host.querySelector<HTMLButtonElement>(".mm-asks-done-toggle")!;
    await act(async () => toggle().click());
    expect(scrolled).not.toHaveBeenCalled();
    await landFold(host.querySelector(".mm-asks-closed")!);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(host.querySelector(".mm-asks-closed > *"));
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
    await act(async () => toggle().click());
    await act(async () => new Promise((done) => setTimeout(done, PRESENCE_EXIT_MS + 40)));
    expect(scrolled).toHaveBeenCalledTimes(1);
  } finally {
    scrolled.mockRestore();
  }
});
