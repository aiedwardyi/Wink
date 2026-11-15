import "@/components/ProfileFields.test-dom.ts";
import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhoneSwipe, type PhoneSwipePeek } from "./use-phone-swipe";
import { useBubbleSwipe } from "./use-bubble-swipe";

type Motion = { node: HTMLElement; frames: Keyframe[]; finish: () => void };
let motions: Motion[];
let frames: Map<number, FrameRequestCallback>;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let selected: ReturnType<typeof vi.fn<(id: string) => void>>;
let peeks: ReturnType<typeof vi.fn<(peek: PhoneSwipePeek | null) => void>>;
let animateDescriptor: PropertyDescriptor | undefined;
let reply: ReturnType<typeof vi.fn<() => void>>;
let translate: ReturnType<typeof vi.fn<() => void>>;

function Harness({ initial = "b", enabled = true, mounts = true }: { initial?: string; enabled?: boolean; mounts?: boolean }) {
  const [id, setId] = useState(initial);
  const [peek, setPeek] = useState<PhoneSwipePeek | null>(null);
  const stage = usePhoneSwipe(id, enabled, (next) => { selected(next); setId(next); }, undefined, (next) => { peeks(next); if (mounts) setPeek(next); });
  return createElement("div", { ref: stage, id: "stage" },
    createElement("p", { id: "message" }, id),
    peek && createElement("div", { "data-peek": peek.id }),
  );
}

function RoomHarness() {
  const [id, setId] = useState("room");
  const [peek, setPeek] = useState<PhoneSwipePeek | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const stage = usePhoneSwipe(id, true, (next) => { selected(next); setId(next); }, undefined, (next) => { peeks(next); setPeek(next); });
  useBubbleSwipe({ row, bubble, canReply: true, canTranslate: true, onReply: reply, onTranslate: translate });
  return createElement("div", { ref: stage, id: "stage" },
    createElement("header", { id: "room-header" }, "Room"),
    createElement("div", { "data-swipe-list": "" },
      createElement("div", { ref: row },
        createElement("div", { ref: bubble, id: "bubble" }, createElement("p", { id: "bubble-text" }, "Message")),
        createElement("span", { id: "row-gap" }),
      ),
      createElement("div", { id: "list-gap" }),
    ),
    peek && createElement("div", { "data-peek": peek.id }),
  );
}

const stage = () => host.querySelector<HTMLElement>("#stage")!;
const peek = () => host.querySelector<HTMLElement>("[data-peek]")?.dataset.peek ?? null;
const mount = (initial = "b", enabled = true, mounts = true) => act(() => root.render(createElement(Harness, { initial, enabled, mounts })));

function touch(type: string, x: number, y: number, timeStamp: number, target = host.querySelector("#message")!) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  act(() => { target.dispatchEvent(event); });
}

function paint() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

async function finishMotion() {
  await act(async () => { for (const motion of motions) motion.finish(); });
}

beforeEach(() => {
  (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 400, height: 844 });
  motions = [];
  frames = new Map();
  selected = vi.fn<(id: string) => void>();
  peeks = vi.fn<(peek: PhoneSwipePeek | null) => void>();
  reply = vi.fn<() => void>();
  translate = vi.fn<() => void>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: function (this: HTMLElement, keyframes: Keyframe[]) {
    let finish!: () => void;
    let cancel!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; cancel = reject; });
    motions.push({ node: this, frames: keyframes, finish });
    return { finished, cancel: () => cancel(new Error("cancelled")) } as unknown as Animation;
  } });
  document.body.innerHTML = ["a", "b", "c"].map((id) => `<div data-sidebar-row-kind="bot" data-sidebar-row-id="${id}"></div>`).join("");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1024, height: 800 });
});

describe("phone swipe pager", () => {
  it("leaves the neighbor unmounted inside touch slop", () => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 292, 301, 20);
    paint();
    expect(peeks).not.toHaveBeenCalled();
    expect(stage().style.transform).toBe("");
    expect(motions).toHaveLength(0);
  });

  it("starts no neighbor work when the gesture resolves to vertical scroll", () => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 292, 301, 20);
    touch("touchmove", 292, 340, 40);
    paint();
    expect(peeks).not.toHaveBeenCalled();
    expect(stage().style.transform).toBe("");
    expect(selected).not.toHaveBeenCalled();
  });

  it.each(["touchend", "touchcancel"])("ends a touch inside slop on %s without a peek or spring", (end) => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 292, 301, 20);
    touch(end, 292, 301, 40);
    paint();
    expect(peeks).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(motions).toHaveLength(0);
    expect(selected).not.toHaveBeenCalled();
  });

  it("moves at the axis lock without waiting for a frame or the neighbor", () => {
    mount("b", true, false);
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    expect(stage().style.transform).toBe("translateX(-160px)");
    expect(frames.size).toBe(0);
    expect(peeks).toHaveBeenLastCalledWith({ from: "b", id: "c", step: 1 });
    expect(peek()).toBeNull();
  });

  it("lands a flick before the neighbor mounts", async () => {
    mount("b", true, false);
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 248, 300, 30);
    touch("touchend", 248, 300, 40);
    expect(motions[0].frames.map((frame) => frame.transform)).toEqual(["translateX(-52px)", "translateX(-400px)"]);
    await finishMotion();
    expect(selected).toHaveBeenCalledExactlyOnceWith("c");
    expect(peeks).toHaveBeenLastCalledWith(null);
    expect(stage().style.transform).toBe("");
  });

  it("springs a cancelled drag back before the neighbor mounts", async () => {
    mount("b", true, false);
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    touch("touchcancel", 140, 300, 2000);
    expect(motions[0].frames.map((frame) => frame.transform)).toEqual(["translateX(-160px)", "translateX(0px)"]);
    await finishMotion();
    expect(frames.size).toBe(0);
    expect(peeks).toHaveBeenLastCalledWith(null);
    expect(selected).not.toHaveBeenCalled();
    expect(stage().style.transform).toBe("");
  });

  it("follows the finger through a reversal before either neighbor mounts", () => {
    mount("b", true, false);
    touch("touchstart", 200, 300, 0);
    touch("touchmove", 100, 300, 1000);
    touch("touchmove", 300, 300, 2000);
    paint();
    expect(peeks).toHaveBeenLastCalledWith({ from: "b", id: "a", step: -1 });
    expect(stage().style.transform).toBe("translateX(100px)");
  });

  it.each([[300, 140, "c", 1], [100, 260, "a", -1]] as const)("previews %s to %s toward %s", (from, to, id, step) => {
    mount();
    touch("touchstart", from, 300, 0);
    touch("touchmove", to, 300, 1000);
    expect(peeks).toHaveBeenLastCalledWith({ from: "b", id, step });
    expect(peek()).toBe(id);
    expect(selected).not.toHaveBeenCalled();
  });

  it("batches drag frames without reannouncing the same neighbor", () => {
    mount();
    touch("touchstart", 300, 300, 0);
    for (let x = 280; x >= 160; x -= 20) touch("touchmove", x, 300, 300 - x);
    expect(frames.size).toBe(1);
    expect(peeks).toHaveBeenCalledTimes(1);
    paint();
    expect(stage().style.transform).toBe("translateX(-140px)");
    expect(frames.size).toBe(0);
  });

  it("finishes from the held offset before selecting, with no second enter animation", async () => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    paint();
    touch("touchend", 140, 300, 2000);
    expect(motions).toHaveLength(1);
    expect(motions[0].frames.map((frame) => frame.transform)).toEqual(["translateX(-160px)", "translateX(-400px)"]);
    expect(selected).not.toHaveBeenCalled();
    expect(peek()).toBe("c");
    await finishMotion();
    expect(selected).toHaveBeenCalledExactlyOnceWith("c");
    expect(stage().style.transform).toBe("");
    expect(peek()).toBeNull();
    expect(motions).toHaveLength(1);
  });

  it.each(["touchend", "touchcancel"])("keeps both pages until the %s spring returns", async (end) => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 270, 300, 1000);
    touch(end, 270, 300, 2000);
    expect(motions[0].frames.map((frame) => frame.transform)).toEqual(["translateX(-30px)", "translateX(0px)"]);
    expect(peek()).toBe("c");
    await finishMotion();
    expect(peek()).toBeNull();
    expect(selected).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it.each([["a", 100, 250, 50], ["c", 300, 150, -50]] as const)("rubber-bands at %s without mounting a neighbor", async (id, from, to, offset) => {
    mount(id);
    touch("touchstart", from, 300, 0);
    touch("touchmove", to, 300, 1000);
    paint();
    expect(stage().style.transform).toBe(`translateX(${offset}px)`);
    expect(peek()).toBeNull();
    expect(peeks).not.toHaveBeenCalled();
    touch("touchend", to, 300, 2000);
    await finishMotion();
    expect(selected).not.toHaveBeenCalled();
  });

  it("releases the peek when disabled during a landing", async () => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    touch("touchend", 140, 300, 2000);
    mount("b", false);
    await finishMotion();
    expect(selected).not.toHaveBeenCalled();
    expect(peek()).toBeNull();
    expect(stage().style.transform).toBe("");
  });

  it("catches an interrupted spring at its displayed offset", async () => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    touch("touchend", 140, 300, 2000);
    const readStyle = getComputedStyle;
    vi.stubGlobal("getComputedStyle", (node: Element) => node === stage() ? { transform: "matrix(1, 0, 0, 1, -240, 0)" } : readStyle(node));
    touch("touchstart", 200, 300, 2100);
    expect(stage().style.transform).toBe("translateX(-240px)");
    touch("touchmove", 180, 300, 2200);
    paint();
    expect(stage().style.transform).toBe("translateX(-260px)");
    await finishMotion();
    expect(selected).not.toHaveBeenCalled();
  });

  it.each([[300, 140, "b"], [100, 260, "a"]] as const)("starts a swipe inside a room toward %s to %s", async (from, to, id) => {
    document.querySelector('[data-sidebar-row-id="b"]')!.insertAdjacentHTML("beforebegin", '<div data-sidebar-row-kind="group" data-sidebar-row-id="room"></div>');
    mount("room");
    touch("touchstart", from, 300, 0);
    touch("touchmove", to, 300, 1000);
    expect(peek()).toBe(id);
    touch("touchend", to, 300, 2000);
    await finishMotion();
    expect(selected).toHaveBeenCalledExactlyOnceWith(id);
    expect(motions).toHaveLength(1);
  });

  it("promotes directly with reduced motion and leaves no pending drag frame", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query.includes("max-width") || query.includes("prefers-reduced-motion"),
      addEventListener() {}, removeEventListener() {},
    } as unknown as MediaQueryList));
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    touch("touchend", 140, 300, 2000);
    expect(selected).toHaveBeenCalledExactlyOnceWith("c");
    expect(motions).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(peek()).toBeNull();
  });

  it("cancels a landing if its page width changes", async () => {
    mount();
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    touch("touchend", 140, 300, 2000);
    Object.defineProperty(stage(), "clientWidth", { configurable: true, value: 600 });
    act(() => { window.dispatchEvent(new Event("resize")); });
    await finishMotion();
    expect(selected).not.toHaveBeenCalled();
    expect(peek()).toBeNull();
    expect(stage().style.transform).toBe("");
  });
});

describe("room gesture ownership at touch start", () => {
  const element = (id: string) => host.querySelector<HTMLElement>(`#${id}`)!;
  function mountRoom() {
    document.querySelector('[data-sidebar-row-id="b"]')!.insertAdjacentHTML("beforebegin", '<div data-sidebar-row-kind="group" data-sidebar-row-id="room"></div>');
    act(() => root.render(createElement(RoomHarness)));
  }

  it.each([[100, 260, "reply"], [300, 140, "translate"]] as const)("keeps a bubble start with %s to %s owned by %s", (from, to, action) => {
    mountRoom();
    touch("touchstart", from, 300, 0, element("bubble-text"));
    touch("touchmove", to, 300, 1000, element("list-gap"));
    paint();
    expect(stage().style.transform).toBe("");
    expect(frames.size).toBe(0);
    expect(peeks).not.toHaveBeenCalled();
    touch("touchend", to, 300, 2000, element("list-gap"));
    expect(action === "reply" ? reply : translate).toHaveBeenCalledTimes(1);
    expect(action === "reply" ? translate : reply).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    expect(motions.filter((motion) => motion.node === stage())).toHaveLength(0);
  });

  it.each(["row-gap", "list-gap", "room-header"])("keeps a %s start owned by the page after moving over a bubble", async (start) => {
    mountRoom();
    touch("touchstart", 300, 300, 0, element(start));
    touch("touchmove", 140, 300, 1000, element("bubble-text"));
    paint();
    expect(stage().style.transform).toBe("translateX(-160px)");
    expect(element("bubble").style.transform).toBe("");
    expect(peek()).toBe("b");
    expect(reply).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
    touch("touchend", 140, 300, 2000, element("bubble-text"));
    await finishMotion();
    expect(selected).toHaveBeenCalledExactlyOnceWith("b");
    expect(reply).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
    expect(motions.filter((motion) => motion.node === element("bubble"))).toHaveLength(0);
  });

  it("keeps ordinary bot message bodies available for paging", async () => {
    mount();
    element("message").setAttribute("data-orbit-message-body", "");
    touch("touchstart", 300, 300, 0);
    touch("touchmove", 140, 300, 1000);
    touch("touchend", 140, 300, 2000);
    await finishMotion();
    expect(selected).toHaveBeenCalledExactlyOnceWith("c");
    expect(reply).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });
});
