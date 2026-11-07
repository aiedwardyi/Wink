// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { LONG_PRESS_MS } from "@/lib/use-touch-drag";
import { StoreProvider, type Bot, type Group } from "@/state/store";

import { GroupMemberRoster } from "./GroupMemberRoster";

const patches: Array<{ memberIds?: string[] }> = [];

// SAFETY: the roster reads only id and name from each bot.
const bots = [{ id: "wink", name: "Wink" }, { id: "pokkey", name: "Pokkey" }, { id: "career", name: "Career" }] as Bot[];

let root: Root;
let opened: Array<string | null>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH" && String(url).endsWith("/api/groups/room-1")) patches.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 404 });
  }));
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
  opened = [];
  // 24 px pictures, 30 px apart, laid out in DOM order
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = [...(this.parentElement?.querySelectorAll("[data-member-id]") ?? [])].indexOf(this) * 30 - (this.parentElement?.scrollLeft ?? 0);
    // SAFETY: the reorder hook reads only left and width.
    return { left, width: 24, right: left + 24, top: 0, bottom: 24, height: 24, x: left, y: 0 } as DOMRect;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  patches.length = 0;
  applyLocale("en");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(memberIds = bots.map((b) => b.id)) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await show(memberIds);
}

async function show(memberIds: string[]) {
  // SAFETY: the roster reads only id and memberIds from the group.
  const group = { id: "room-1", memberIds } as Group;
  const members = memberIds.flatMap((id) => bots.filter((b) => b.id === id));
  await act(async () =>
    root.render(
      createElement(StoreProvider, null, createElement(GroupMemberRoster, {
        group,
        members,
        mauses: members.map((b) => createElement("span", { key: b.id }, b.name)),
        onOpen: (pressed) => opened.push(pressed?.dataset.memberId ?? pressed?.textContent ?? null),
        children: createElement("button", { type: "button" }, "+"),
      })),
    ),
  );
}

const picture = (id: string) => document.querySelector<HTMLElement>(`[data-member-id="${id}"]`)!;
const saved = () => patches.map((body) => body.memberIds);
const at = (id: string) => [...document.querySelectorAll("[data-member-id]")].indexOf(picture(id)) * 30 + 12;

let down = "";
async function pointer(type: string, x: number, pointerType = "mouse") {
  const init = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 12, pointerId: 1, pointerType };
  await act(async () => {
    if (type === "pointerdown") picture(down).dispatchEvent(new PointerEvent(type, init));
    else window.dispatchEvent(new PointerEvent(type, init));
  });
}
async function press(id: string, pointerType = "mouse") {
  down = id;
  await pointer("pointerdown", at(id), pointerType);
}
const click = (el: HTMLElement) => act(async () => el.click());

describe("group member roster", () => {
  it("drags a picture with the mouse and saves the new answer order", async () => {
    await render();
    await press("wink");
    await pointer("pointermove", at("wink") + 50);
    await pointer("pointerup", at("wink") + 50);
    expect(saved()).toEqual([["pokkey", "wink", "career"]]);
  });

  it("keeps ids without a bot at the end of the saved roster", async () => {
    await render(["wink", "gone", "pokkey", "career"]);
    await press("career");
    await pointer("pointermove", 0);
    await pointer("pointerup", 0);
    expect(saved()).toEqual([["career", "wink", "pokkey", "gone"]]);
  });

  it("swallows the click that ends a drag, and a plain click still opens Manage members", async () => {
    await render();
    await press("wink");
    await pointer("pointermove", at("wink") + 50);
    await pointer("pointerup", at("wink") + 50);
    await click(picture("wink"));
    expect(opened).toEqual([]);
    await press("pokkey");
    await pointer("pointerup", at("pokkey"));
    await click(picture("pokkey"));
    expect(opened).toEqual(["pokkey"]);
    expect(saved()).toHaveLength(1);
  });

  it("puts a picture back when Escape cancels the drag", async () => {
    await render();
    await press("wink");
    await pointer("pointermove", at("wink") + 70);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await pointer("pointerup", at("wink") + 70);
    expect(saved()).toEqual([]);
  });

  it("drops a drag without saving when the room closes mid-drag", async () => {
    await render();
    await press("wink");
    await pointer("pointermove", at("wink") + 50);
    await act(async () => root.render(createElement(StoreProvider, null)));
    await pointer("pointerup", at("wink") + 50);
    expect(saved()).toEqual([]);
  });

  it("lifts on touch only after a long press", async () => {
    vi.useFakeTimers();
    await render();
    await press("career", "touch");
    await pointer("pointermove", 0, "touch");
    await pointer("pointerup", 0, "touch");
    expect(saved()).toEqual([]);

    await press("career", "touch");
    await act(async () => vi.advanceTimersByTime(LONG_PRESS_MS));
    await pointer("pointermove", 0, "touch");
    await pointer("pointerup", 0, "touch");
    expect(saved()).toEqual([["career", "wink", "pokkey"]]);
  });

  it("leaves a touch tap to open Manage members", async () => {
    vi.useFakeTimers();
    await render();
    await press("pokkey", "touch");
    await pointer("pointerup", at("pokkey"), "touch");
    await click(picture("pokkey"));
    expect(opened).toEqual(["pokkey"]);
    expect(saved()).toEqual([]);
  });

  it("keeps Manage outside the scrolling faces and allows native horizontal swipes", async () => {
    await render();
    const strip = picture("wink").parentElement!;
    expect(strip.contains([...document.querySelectorAll("button")].find((el) => el.textContent === "+")!)).toBe(false);
    expect(strip.className).toContain("overflow-x-auto");
    expect(picture("wink").className).not.toContain("touch-none");
  });

  it("swallows a sideways swipe without lifting or opening Manage", async () => {
    vi.useFakeTimers();
    await render();
    await press("wink", "touch");
    await pointer("pointermove", at("wink") + 40, "touch");
    await act(async () => vi.advanceTimersByTime(LONG_PRESS_MS));
    await pointer("pointerup", at("wink") + 40, "touch");
    await click(picture("wink"));
    expect(saved()).toEqual([]);
    expect(opened).toEqual([]);
    expect(picture("wink").style.scale).toBe("");
  });

  it.each(["first", "last"])("autoscrolls the %s face to the opposite end while held at the edge", async (end) => {
    vi.useFakeTimers();
    const extra = Array.from({ length: 9 }, (_, i) => ({ ...bots[0]!, id: `extra-${i}`, name: `Member ${i}` }));
    bots.push(...extra);
    try {
      await render();
      const strip = picture("wink").parentElement!;
      Object.defineProperties(strip, { clientWidth: { value: 90 }, scrollWidth: { value: 354 } });
      strip.getBoundingClientRect = () => new DOMRect(0, 0, 90, 24);
      const last = bots.at(-1)!.id;
      strip.scrollLeft = end === "last" ? 264 : 0;
      const id = end === "last" ? last : "wink";
      await press(id, "touch");
      await act(async () => vi.advanceTimersByTime(LONG_PRESS_MS));
      const move = new Event("touchmove", { bubbles: true, cancelable: true });
      await act(async () => picture(id).dispatchEvent(move));
      expect(move.defaultPrevented).toBe(true);
      await pointer("pointermove", end === "last" ? 1 : 89, "touch");
      await act(async () => vi.advanceTimersByTime(800));
      expect(strip.scrollLeft).toBe(end === "last" ? 0 : 264);
      await pointer("pointerup", end === "last" ? 1 : 89, "touch");
      expect(saved()[0]).toEqual(end === "last" ? [last, ...bots.slice(0, -1).map((b) => b.id)] : [...bots.slice(1).map((b) => b.id), "wink"]);
      const stopped = strip.scrollLeft;
      await act(async () => vi.advanceTimersByTime(200));
      expect(strip.scrollLeft).toBe(stopped);
    } finally {
      bots.splice(3);
    }
  });

  it("moves with Alt+Left/Right like the sidebar, keeps focus and says where it went", async () => {
    await render();
    const key = (id: string, k: string, altKey = true) =>
      act(async () => picture(id).dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey, bubbles: true })));
    await key("wink", "ArrowRight", false);
    await key("wink", "ArrowLeft");
    expect(saved()).toEqual([]);
    picture("wink").focus();
    await key("wink", "ArrowRight");
    expect(saved()).toEqual([["pokkey", "wink", "career"]]);
    await show(saved()[0]!);
    expect([...document.querySelectorAll("[data-member-id]")].map((el) => el.getAttribute("data-member-id"))).toEqual(["pokkey", "wink", "career"]);
    expect(document.activeElement).toBe(picture("wink"));
    expect(document.querySelector("[aria-live]")?.textContent).toBe("Wink moved to position 2 of 3");
    expect(picture("wink").getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowLeft Alt+ArrowRight");
  });

  it("says the move in Korean", async () => {
    applyLocale("ko");
    await render();
    await act(async () => picture("career").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })));
    expect(document.querySelector("[aria-live]")?.textContent).toBe("Career이(가) 3개 중 2번째로 이동했습니다");
  });
});
