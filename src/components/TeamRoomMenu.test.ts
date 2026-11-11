// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { en, ko } from "@/lib/i18n-catalog";

import { TeamRoomMenuItems } from "./TeamRoomMenu";

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

  it("drops the separate team room create strings", () => {
    for (const catalog of [en, ko]) {
      expect(catalog).not.toHaveProperty("teamRoom.new");
      expect(catalog).not.toHaveProperty("teamRoom.create");
      expect(catalog).not.toHaveProperty("teamRoom.namePlaceholder");
    }
  });
});
