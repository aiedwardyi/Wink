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
  default: ({ release, onClose }: { release: string; onClose: () => void }) => createElement("button", { className: "card", "data-release": release, onClick: onClose }),
}));

const { WhatsNewSlot } = await import("./WhatsNew");

async function fresh() {
  vi.resetModules();
  const mod = await import("./WhatsNew");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const Chat = ({ last, thread }: { last?: string; thread?: string }) => createElement("div", { "data-anchor": String(mod.useWhatsNewAnchor()) }, createElement(mod.WhatsNewSlot, { last, thread }));
  const render = (last?: string, thread?: string) => act(() => root.render(createElement(Chat, { last, thread })));
  const settle = (ms = 1500) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  });
  const done = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, render, settle, done, anchor: () => host.querySelector("div")?.dataset.anchor, card: () => host.querySelector<HTMLButtonElement>(".card") };
}

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
