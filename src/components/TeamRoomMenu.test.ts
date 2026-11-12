// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";

const store = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: { profile: { name: "Eddie" } }, groups: [], bots: [] }, dispatch: store.dispatch }),
}));

import { TeamRoomDialogs, TeamRoomMenuItems } from "./TeamRoomMenu";

afterEach(() => {
  applyLocale("en");
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("+ menu room items", () => {
  it.each([["en", "Join with code"], ["ko", "코드로 참여"]] as const)("offers only Join with code in %s", async (locale, label) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("omb-locale", locale);
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(I18nProvider, null, createElement(TeamRoomMenuItems, { onPick: () => undefined }))));
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual([label]);
    await act(async () => root.unmount());
  });

  it.each([["en", "You host this room. It's open now."], ["ko", "내가 호스트인 채팅방이에요. 지금 열었어요."]] as const)("opens this PC's own room instead of joining it, in %s", async (locale, note) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "own-room", groupId: "g-tk" }), { status: 409 })));
    localStorage.setItem("omb-locale", locale);
    store.dispatch.mockClear();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(createElement(I18nProvider, null, createElement(TeamRoomMenuItems, { onPick: () => undefined }), createElement(TeamRoomDialogs))));
    await act(async () => document.querySelector("button")!.click());
    await act(async () => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      event.clipboardData = { getData: () => "ABCDEF" };
      document.querySelector("[data-join-boxes] input")!.dispatchEvent(event);
    });
    expect(store.dispatch).toHaveBeenCalledWith({ type: "select", id: "g-tk" });
    expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toBe(note);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("drops the separate team room create strings", () => {
    for (const catalog of [en, ko]) {
      expect(catalog).not.toHaveProperty("teamRoom.new");
      expect(catalog).not.toHaveProperty("teamRoom.create");
      expect(catalog).not.toHaveProperty("teamRoom.namePlaceholder");
    }
  });
});
