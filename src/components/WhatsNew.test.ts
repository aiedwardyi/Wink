// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.fn((..._args: unknown[]) => Promise.resolve({ release: "1.0.246" }));
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ state: { hydrated: true } }) }));
vi.mock("./WhatsNewCard", () => ({
  default: ({ onClose }: { onClose: () => void }) => createElement("button", { className: "card", onClick: onClose }),
}));

const { WhatsNewSlot } = await import("./WhatsNew");

describe("whats new slot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows one card across every mounted chat and closing it closes it everywhere", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const cards = () => host.querySelectorAll<HTMLButtonElement>(".card");
    act(() => root.render(createElement(Fragment, null, createElement(WhatsNewSlot), createElement(WhatsNewSlot))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      await vi.dynamicImportSettled();
    });
    expect(cards()).toHaveLength(1);
    act(() => cards()[0].click());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(cards()).toHaveLength(0);
    act(() => root.unmount());
    host.remove();
  });
});
