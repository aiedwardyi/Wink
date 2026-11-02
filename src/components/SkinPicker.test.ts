import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { LIGHT_SKIN_IDS, SKINS, applySkin, nextSkin, type SkinId } from "@/lib/skins";
import { SkinPicker } from "./SkinPicker";

let root: Root;
const featured = ["Wink", "Precision", "GitHub Dimmed", "Tokyo Night", "Kanagawa", "Terminal", "Wink Day", "Notebook"];
const names = () => [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].map((button) => button.textContent);

async function mount(skin: SkinId = "precision", locale: "en" | "ko" = "en") {
  vi.stubGlobal("localStorage", window.localStorage);
  persistPreference(locale);
  applySkin(skin);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(SkinPicker))));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  applySkin("precision");
  persistPreference("en");
  vi.unstubAllGlobals();
});

describe("featured themes", () => {
  it.each(["en", "ko"] as const)("starts folded with eight featured themes in %s and reveals every remaining theme", async (locale) => {
    await mount("precision", locale);
    expect(names()).toEqual(featured);
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(more).not.toBeNull();
    expect(more.textContent).toContain(locale === "en" ? "More themes" : "더 많은 테마");
    expect(more.textContent).toContain(String(SKINS.length - 8));
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(names()).toHaveLength(SKINS.length);
    expect(new Set(names()).size).toBe(SKINS.length);
    await act(async () => more.click());
    expect(names()).toEqual(featured);
  });

  it("keeps an extra active theme up front, follows external changes and resets the fold on remount", async () => {
    await mount("pewter-night");
    expect(names()).toContain("Pewter Night");
    expect(names()).toHaveLength(9);
    expect(document.querySelector('[aria-pressed="true"]')?.textContent).toBe("Pewter Night");
    await act(async () => applySkin("blueprint-gray"));
    expect(names()).toContain("Blueprint Gray");
    expect(names()).not.toContain("Pewter Night");
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(more.textContent).toContain(String(SKINS.length - 9));
    await act(async () => more.click());
    const servo = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((button) => button.textContent === "Servo Gray")!;
    expect(servo).toBeTruthy();
    await act(async () => servo.click());
    expect(document.documentElement.dataset.skin).toBe("servo-gray");
    await act(async () => root.unmount());
    await mount("servo-gray");
    expect(names()).toContain("Servo Gray");
    expect(document.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("cycles all themes in dark then light order including Servo Gray", () => {
    const order = [...SKINS.filter((skin) => !LIGHT_SKIN_IDS.has(skin.id)), ...SKINS.filter((skin) => LIGHT_SKIN_IDS.has(skin.id))];
    expect(order.map((skin) => skin.id)).toContain("servo-gray");
    for (let i = 0; i < order.length; i++) expect(nextSkin(order[i].id)).toBe(order[(i + 1) % order.length].id);
  });
});
