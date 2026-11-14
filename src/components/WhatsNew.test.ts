// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CATCHING_UP_POLL_MS } from "@/lib/use-catching-up";

let catchingUp: boolean | null = false;
const api = vi.fn((...args: unknown[]): Promise<unknown> =>
  Promise.resolve(String(args[0]).startsWith("/api/catching-up/") ? { catchingUp } : { release: "1.0.248", seen: "1.0.245" }));
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ state: { hydrated: true } }) }));
vi.mock("@/lib/whats-new", () => ({
  unseenRelease: (release: string, seen: string | null) => (release === "1.0.248" && seen === "1.0.245" ? "1.0.246" : null),
}));
vi.mock("./WhatsNewCard", () => ({
  default: ({ release, theme, onClose }: { release?: string; theme?: string; onClose: () => void }) =>
    createElement("button", { className: "card", "data-release": release, "data-theme": theme, onClick: onClose }),
}));

const { WhatsNewSlot } = await import("./WhatsNew");

async function fresh() {
  vi.resetModules();
  const mod = await import("./WhatsNew");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const Chat = ({ last, thread, hidden }: { last?: string; thread?: string; hidden?: boolean }) => createElement("div", { "data-anchor": String(mod.useWhatsNewAnchor()) }, createElement(mod.WhatsNewSlot, { last, thread, hidden }));
  const render = (last?: string, thread?: string, hidden?: boolean) => act(() => root.render(createElement(Chat, { last, thread, hidden })));
  const settle = (ms = 1500) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  });
  const done = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { mod, host, render, settle, done, anchor: () => host.querySelector("div")?.dataset.anchor, card: () => host.querySelector<HTMLButtonElement>(".card") };
}

const themeSeen = (theme: string) => {
  const post = JSON.stringify(["/api/whats-new/seen", { method: "POST", body: JSON.stringify({ theme }) }]);
  return api.mock.calls.filter((call) => JSON.stringify(call) === post);
};

describe("whats new slot", () => {
  afterEach(() => {
    vi.useRealTimers();
    api.mockClear();
    catchingUp = false;
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

  it("records the release seen only when the card closes", async () => {
    vi.useFakeTimers();
    const chat = await fresh();
    chat.render("m2");
    await chat.settle();
    expect(chat.card()).not.toBeNull();
    expect(api.mock.calls.some(([path]) => path === "/api/whats-new/seen")).toBe(false);
    act(() => chat.card()!.click());
    expect(api).toHaveBeenCalledWith("/api/whats-new/seen", { method: "POST", body: JSON.stringify({ release: "1.0.246" }) });
    chat.done();
  });

  it("anchors the card after the message that was last when it showed", async () => {
    vi.useFakeTimers();
    const chat = await fresh();
    chat.render("m2");
    await chat.settle();
    expect(chat.anchor()).toBe("m2");
    expect(api).toHaveBeenCalledWith("/api/whats-new/anchor", { method: "POST", body: JSON.stringify({ release: "1.0.246", id: "m2" }) });
    chat.render("m4");
    expect(chat.anchor()).toBe("m2");
    chat.done();
  });

  it("restores the saved anchor for the same notes and ignores one for other notes", async () => {
    vi.useFakeTimers();
    api.mockImplementationOnce(() => Promise.resolve({ release: "1.0.248", seen: "1.0.245", anchor: { release: "1.0.246", id: "m1" } }));
    let chat = await fresh();
    chat.render("m9");
    await chat.settle();
    expect(chat.anchor()).toBe("m1");
    expect(api.mock.calls.some(([path]) => path === "/api/whats-new/anchor")).toBe(false);
    chat.done();
    api.mockImplementationOnce(() => Promise.resolve({ release: "1.0.248", seen: "1.0.245", anchor: { release: "1.0.245", id: "m1" } }));
    chat = await fresh();
    chat.render("m9");
    await chat.settle();
    expect(chat.anchor()).toBe("m9");
    chat.done();
  });

  it("holds fresh notes while the chat catches up with another PC, then anchors under what it pulled", async () => {
    vi.useFakeTimers();
    catchingUp = null;
    const chat = await fresh();
    chat.render("m2", "t1");
    await chat.settle();
    expect(api).toHaveBeenCalledWith("/api/catching-up/t1");
    expect(chat.card()).toBeNull();
    catchingUp = true;
    chat.render("m6", "t1");
    await chat.settle(CATCHING_UP_POLL_MS);
    expect(chat.card()).toBeNull();
    expect(chat.anchor()).toBe("undefined");
    catchingUp = false;
    await chat.settle(CATCHING_UP_POLL_MS);
    expect(chat.card()).not.toBeNull();
    expect(chat.anchor()).toBe("m6");
    expect(api).toHaveBeenCalledWith("/api/whats-new/anchor", { method: "POST", body: JSON.stringify({ release: "1.0.246", id: "m6" }) });
    chat.render("m7", "t1");
    expect(chat.anchor()).toBe("m6");
    chat.done();
  });

  it("does not wait when the catch-up cannot be asked or the notes were already placed", async () => {
    vi.useFakeTimers();
    catchingUp = true;
    api.mockImplementationOnce(() => Promise.resolve({ release: "1.0.248", seen: "1.0.245" })).mockImplementationOnce(() => Promise.reject(new Error("offline")));
    let chat = await fresh();
    chat.render("m2", "t1");
    await chat.settle();
    expect(chat.card()).not.toBeNull();
    expect(chat.anchor()).toBe("m2");
    chat.done();
    api.mockClear();
    api.mockImplementationOnce(() => Promise.resolve({ release: "1.0.248", seen: "1.0.245", anchor: { release: "1.0.246", id: "m1" } }));
    chat = await fresh();
    chat.render("m9", "t1");
    await chat.settle();
    expect(chat.card()).not.toBeNull();
    expect(chat.anchor()).toBe("m1");
    expect(api.mock.calls.some(([path]) => String(path).startsWith("/api/catching-up/"))).toBe(false);
    chat.done();
  });

  it("stops waiting for a Drive listing that never comes", async () => {
    vi.useFakeTimers();
    catchingUp = null;
    const chat = await fresh();
    chat.render("m2", "t1");
    await chat.settle();
    await chat.settle(56_000);
    expect(chat.card()).toBeNull();
    await chat.settle(CATCHING_UP_POLL_MS);
    expect(chat.card()).not.toBeNull();
    expect(chat.anchor()).toBe("m2");
    chat.done();
  });

  it("asks again when the visible chat changed while it was asking", async () => {
    vi.useFakeTimers();
    let answer = (_body: { catchingUp: boolean }) => {};
    api.mockImplementationOnce(() => Promise.resolve({ release: "1.0.248", seen: "1.0.245" })).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    catchingUp = true;
    const chat = await fresh();
    chat.render("a2", "t1");
    await chat.settle();
    chat.render("b2", "t2");
    answer({ catchingUp: false });
    await chat.settle(0);
    expect(chat.card()).toBeNull();
    await chat.settle(CATCHING_UP_POLL_MS);
    expect(api).toHaveBeenCalledWith("/api/catching-up/t2");
    expect(chat.card()).toBeNull();
    catchingUp = false;
    await chat.settle(CATCHING_UP_POLL_MS);
    expect(chat.anchor()).toBe("b2");
    chat.done();
  });

  it("shows a picked animated theme's row in the visible chat and records it once the scene has played", async () => {
    vi.useFakeTimers();
    api.mockImplementationOnce(() => Promise.resolve({ release: null, themes: [] }));
    const chat = await fresh();
    chat.render("m2", undefined, true);
    await chat.settle();
    act(() => chat.mod.offerThemeRow("lagoon"));
    act(() => chat.mod.scenePlayed("lagoon"));
    await chat.settle();
    expect(chat.card()).toBeNull();
    expect(themeSeen("lagoon")).toHaveLength(0);
    chat.render("m2");
    await chat.settle();
    expect(chat.card()?.dataset.theme).toBe("lagoon");
    expect(chat.card()?.dataset.release).toBeUndefined();
    expect(chat.anchor()).toBe("m2");
    expect(api.mock.calls.some(([path]) => path === "/api/whats-new/anchor")).toBe(false);
    expect(themeSeen("lagoon")).toHaveLength(1);
    act(() => chat.mod.scenePlayed("lagoon"));
    chat.render("m4");
    expect(themeSeen("lagoon")).toHaveLength(1);
    expect(chat.card()?.dataset.theme).toBe("lagoon");
    expect(chat.anchor()).toBe("m2");
    chat.done();
  });

  it("keeps the row up, unrecorded, until its own scene plays", async () => {
    vi.useFakeTimers();
    api.mockImplementationOnce(() => Promise.resolve({ release: null, themes: [] }));
    const chat = await fresh();
    chat.render("m2");
    await chat.settle();
    expect(chat.card()).toBeNull();
    act(() => chat.mod.offerThemeRow("snow"));
    await chat.settle();
    expect(chat.card()?.dataset.theme).toBe("snow");
    act(() => chat.mod.scenePlayed("lagoon"));
    expect(api.mock.calls.some(([path]) => path === "/api/whats-new/seen")).toBe(false);
    act(() => chat.mod.scenePlayed("snow"));
    expect(themeSeen("snow")).toHaveLength(1);
    chat.done();
  });

  it("never shows the row of a theme that already showed on this PC, or one closed by its X", async () => {
    vi.useFakeTimers();
    api.mockImplementationOnce(() => Promise.resolve({ release: null, themes: ["snow"] }));
    const chat = await fresh();
    chat.render("m2");
    await chat.settle();
    act(() => chat.mod.offerThemeRow("snow"));
    await chat.settle();
    expect(chat.card()).toBeNull();
    act(() => chat.mod.offerThemeRow("lagoon"));
    await chat.settle();
    act(() => chat.card()!.click());
    expect(themeSeen("lagoon")).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(chat.card()).toBeNull();
    expect(chat.anchor()).toBe("undefined");
    act(() => chat.mod.offerThemeRow(null));
    act(() => chat.mod.offerThemeRow("lagoon"));
    await chat.settle();
    expect(chat.card()).toBeNull();
    chat.done();
  });

  it("holds the row behind the release card and drops it when another theme is picked", async () => {
    vi.useFakeTimers();
    const chat = await fresh();
    chat.render("m2");
    await chat.settle();
    act(() => chat.mod.offerThemeRow("lagoon"));
    act(() => chat.mod.scenePlayed("lagoon"));
    await chat.settle();
    expect(chat.card()?.dataset.release).toBe("1.0.246");
    expect(themeSeen("lagoon")).toHaveLength(0);
    act(() => chat.card()!.click());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await chat.settle();
    expect(chat.card()?.dataset.theme).toBe("lagoon");
    expect(themeSeen("lagoon")).toHaveLength(1);
    act(() => chat.mod.offerThemeRow(null));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(chat.card()).toBeNull();
    act(() => chat.mod.offerThemeRow("lagoon"));
    await chat.settle();
    expect(chat.card()).toBeNull();
    chat.done();
  });

  it("keeps the row back while fresh notes are held, so the notes still land under what the chat pulled", async () => {
    vi.useFakeTimers();
    catchingUp = true;
    const chat = await fresh();
    chat.render("m2", "t1");
    await chat.settle();
    act(() => chat.mod.offerThemeRow("lagoon"));
    await chat.settle(0);
    expect(chat.card()).toBeNull();
    expect(chat.anchor()).toBe("undefined");
    chat.render("m6", "t1");
    catchingUp = false;
    await chat.settle(CATCHING_UP_POLL_MS);
    expect(chat.card()?.dataset.release).toBe("1.0.246");
    expect(chat.anchor()).toBe("m6");
    chat.done();
  });

  it("leaves an empty chat's card at the bottom", async () => {
    vi.useFakeTimers();
    const chat = await fresh();
    chat.render();
    await chat.settle();
    expect(chat.card()).not.toBeNull();
    expect(chat.anchor()).toBe("null");
    chat.done();
  });
});
