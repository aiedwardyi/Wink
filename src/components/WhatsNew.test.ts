// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.fn((..._args: unknown[]) => Promise.resolve({ release: "1.0.248", seen: "1.0.245" }));
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ state: { hydrated: true } }) }));
vi.mock("@/lib/whats-new", () => ({
  unseenRelease: (release: string, seen: string | null) => (release === "1.0.248" && seen === "1.0.245" ? "1.0.246" : null),
}));
vi.mock("./WhatsNewCard", () => ({
  default: ({ release, onClose }: { release: string; onClose: () => void }) => createElement("button", { className: "card", "data-release": release, onClick: onClose }),
}));

const { WhatsNewSlot } = await import("./WhatsNew");

describe("whats new slot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows the visible chat and keeps one copy as chats switch", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const cards = () => host.querySelectorAll<HTMLButtonElement>(".card");
    const chats = (activeB: boolean) =>
      createElement(
        Fragment,
        null,
        createElement("div", { id: "a" }, createElement(WhatsNewSlot, { hidden: activeB })),
        createElement("div", { id: "b" }, createElement(WhatsNewSlot, { hidden: !activeB })),
      );
    act(() => root.render(chats(true)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      await vi.dynamicImportSettled();
    });
    expect(host.querySelectorAll("#b .card")).toHaveLength(1);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].dataset.release).toBe("1.0.246");
    act(() => root.render(chats(false)));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(host.querySelectorAll("#a .card")).toHaveLength(1);
    expect(cards()).toHaveLength(1);
    act(() => root.unmount());
    host.remove();
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
