// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";

import { TeamRoomTranscript } from "./TeamRoomRow";

vi.mock("@/lib/room-translate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/room-translate")>(),
  useTranslationAvailable: () => false,
}));

vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStoreDispatch: () => () => undefined,
}));

const NOTICE = "금요일 점심 12시\n장소: 2층 라운지\n늦으면 연락 주세요";
const lines: RoomLine[] = [
  { id: "e1", at: 1, author: { kind: "host", id: "host", name: "Edward" }, text: NOTICE, files: [], reactions: [{ emoji: "👍", by: "person:mina" }] },
  { id: "e2", at: 2, author: { kind: "person", id: "mina", name: "Mina Park" }, text: "PR #1304 머지했어요", files: [], reactions: [{ emoji: "🔥", by: "user" }, { emoji: "🔥", by: "person:seoyeon" }] },
];
const names = new Map([["person:mina", "Mina Park"], ["person:seoyeon", "이서연"]]);
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  applyLocale("en");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function render(props: Record<string, unknown> = {}) {
  await act(async () => root.render(createElement(TeamRoomTranscript, {
    onReply: () => {}, lines, mine: (line: RoomLine) => line.author.kind === "host", base: "/api/rooms/r1", label: "런치 준비 - Launch week", reactionNames: names, ...props,
  })));
}

const row = (id: string) => host.querySelector<HTMLElement>(`[data-mid="${id}"]`)!;
const openMenu = async (id: string) => {
  await act(async () => row(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
  return document.querySelector<HTMLElement>("[data-message-menu]");
};

describe("room reactions", () => {
  it("shows a counted chip with people's names on hover, and a tap toggles through the room", async () => {
    const onReact = vi.fn();
    await render({ onReact });
    const chips = [...host.querySelectorAll<HTMLButtonElement>("[data-message-reactions] button")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["👍1", "🔥2"]);
    expect(chips.map((chip) => chip.title)).toEqual(["Mina Park", "You, 이서연"]);
    await act(async () => chips[0]!.click());
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }), "👍");
  });

  it("offers the emoji row on others' lines only, and none when the host can't take reactions", async () => {
    const onReact = vi.fn();
    await render({ onReact });
    const menu = await openMenu("e2");
    expect(menu?.querySelectorAll("[data-menu-reaction]")).toHaveLength(6);
    await act(async () => menu!.querySelector<HTMLButtonElement>('[data-menu-reaction="😂"]')!.click());
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: "e2" }), "😂");
    expect((await openMenu("e1"))?.querySelector("[data-menu-reaction]")).toBeNull();
    await render({ onReact: undefined });
    const old = await openMenu("e2");
    expect(old?.querySelector("[data-menu-reaction]")).toBeNull();
    expect(old?.querySelector("[data-menu-reply]")).not.toBeNull();
    expect(old?.querySelector("[data-menu-copy]")).not.toBeNull();
    expect(old?.querySelector("[data-menu-pin]")).toBeNull();
  });
});

describe("room notice", () => {
  it("pins from the menu and unpins only when allowed", async () => {
    const set = vi.fn();
    await render({ notice: { set, canUnpin: false } });
    const menu = await openMenu("e2");
    expect(menu?.querySelector("[data-menu-pin]")?.textContent).toBe("Pin as notice");
    await act(async () => menu!.querySelector<HTMLButtonElement>("[data-menu-pin]")!.click());
    expect(set).toHaveBeenCalledWith("e2");
    await render({ notice: { set, entryId: "e2", canUnpin: false } });
    expect((await openMenu("e2"))?.querySelector("[data-menu-pin]")).toBeNull();
    await render({ notice: { set, entryId: "e2", canUnpin: true } });
    const unpin = (await openMenu("e2"))!.querySelector<HTMLButtonElement>("[data-menu-pin]")!;
    expect(unpin.textContent).toBe("Unpin notice");
    await act(async () => unpin.click());
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it("folds to the first line, expands on the chevron, remembers it, and jumps on tap", async () => {
    await render({ notice: { set: () => {}, entryId: "e1", canUnpin: true } });
    const banner = () => host.querySelector<HTMLElement>("[data-room-notice]")!;
    expect(banner().textContent).toContain("금요일 점심 12시");
    expect(banner().textContent).not.toContain("늦으면 연락 주세요");
    const chevron = () => banner().querySelector<HTMLButtonElement>("[data-room-notice-fold]")!;
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    await act(async () => chevron().click());
    expect(banner().textContent).toContain("늦으면 연락 주세요");
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ notice: { set: () => {}, entryId: "e1", canUnpin: true } });
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
    const scroll = vi.fn();
    row("e1").scrollIntoView = scroll;
    await act(async () => banner().querySelector<HTMLButtonElement>("[data-room-notice-jump]")!.click());
    expect(scroll).toHaveBeenCalled();
  });

  it("shows nothing without a notice and a label when its line isn't loaded", async () => {
    await render({ notice: { set: () => {}, canUnpin: true } });
    expect(host.querySelector("[data-room-notice]")).toBeNull();
    await render({ notice: { set: () => {}, entryId: "gone", canUnpin: true } });
    expect(host.querySelector("[data-room-notice]")?.textContent).toContain("Notice");
  });
});
