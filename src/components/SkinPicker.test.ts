import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { LIGHT_SKIN_IDS, SKINS, applySkin, nextSkin, type SkinId } from "@/lib/skins";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { SkinPicker } from "./SkinPicker";

let root: Root;
const featured = ["Precision", "GitHub Dimmed", "Tokyo Night", "Terminal", "Inkwell", "Graphite", "Moss", "Wink Day", "Notebook"];
const hidden = ["Wink Violet", "Wink Black", "Pewter"];
const tiles = () => [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
const names = () => tiles().map((button) => button.querySelector(".font-medium")?.textContent);
const tagged = () => tiles().filter((button) => button.querySelector("[data-skin-new]")).map((button) => button.querySelector(".font-medium")?.textContent);
// the extra themes fold away on the shared motion before they unmount
const folded = () => act(async () => { await new Promise((done) => setTimeout(done, PRESENCE_EXIT_MS + 40)); });

async function mount(skin: SkinId = "precision", locale: "en" | "ko" = "en") {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.removeItem("omb-skins-tried");
  persistPreference(locale);
  applySkin(skin);
  await render();
}

async function render() {
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
  it.each(["en", "ko"] as const)("starts folded with nine featured themes in %s and reveals every offered theme", async (locale) => {
    await mount("precision", locale);
    expect(names()).toEqual(featured);
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(more).not.toBeNull();
    expect(more.textContent).toContain(locale === "en" ? "More themes" : "더 많은 테마");
    expect(more.textContent).toContain(String(SKINS.length - featured.length - hidden.length));
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(names()).toHaveLength(SKINS.length - hidden.length);
    expect(new Set(names()).size).toBe(SKINS.length - hidden.length);
    for (const name of hidden) expect(names()).not.toContain(name);
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await folded();
    expect(names()).toEqual(featured);
  });

  it("keeps an extra active theme up front, follows external changes and resets the fold on remount", async () => {
    await mount("pewter-night");
    expect(names()).toContain("Pewter Night");
    expect(names()).toHaveLength(10);
    expect(document.querySelector('[aria-pressed="true"]')?.textContent).toBe("Pewter Night");
    await act(async () => applySkin("blueprint-gray"));
    expect(names()).toContain("Blueprint Gray");
    expect(names()).not.toContain("Pewter Night");
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(more.textContent).toContain(String(SKINS.length - featured.length - 1 - hidden.length));
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

  it("keeps focus on a theme picked from the open fold and promotes it once folded", async () => {
    await mount("precision");
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => more.click());
    const servo = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((button) => button.textContent === "Servo Gray")!;
    servo.focus();
    await act(async () => servo.click());
    expect(servo.isConnected).toBe(true);
    expect(document.activeElement).toBe(servo);
    expect(servo.getAttribute("aria-pressed")).toBe("true");
    await act(async () => more.click());
    await folded();
    expect(names()).toEqual([...featured.slice(0, 7), "Servo Gray", ...featured.slice(7)]);
  });

  it("puts the new themes in a two-by-four Dark front row with the current-theme slot", async () => {
    await mount("kanagawa");
    expect(names()).toEqual([...featured.slice(0, 7), "Kanagawa", ...featured.slice(7)]);
    await act(async () => applySkin("precision"));
    expect(names()).not.toContain("Kanagawa");
    expect(names()).not.toContain("Wink");
  });

  it.each(["wink-violet", "wink-black", "pewter"] as const)("keeps hidden %s applyable and shows it up front while on", async (id) => {
    await mount(id);
    expect(document.documentElement.dataset.skin).toBe(id);
    const name = SKINS.find((skin) => skin.id === id)!.name;
    expect(names()).toEqual([...featured.slice(0, 7), name, ...featured.slice(7)]);
    expect(document.querySelector('[aria-pressed="true"]')?.querySelector(".font-medium")?.textContent).toBe(name);
  });

  it("cycles all themes in dark then light order including Servo Gray", () => {
    const order = [...SKINS.filter((skin) => !LIGHT_SKIN_IDS.has(skin.id)), ...SKINS.filter((skin) => LIGHT_SKIN_IDS.has(skin.id))];
    expect(order.map((skin) => skin.id)).toContain("servo-gray");
    for (let i = 0; i < order.length; i++) expect(nextSkin(order[i].id)).toBe(order[(i + 1) % order.length].id);
  });
});

describe("New tag", () => {
  it.each(["en", "ko"] as const)("marks the three new themes until tried in %s", async (locale) => {
    await mount("precision", locale);
    expect(tagged()).toEqual(["Inkwell", "Graphite", "Moss"]);
    expect(document.querySelector("[data-skin-new]")?.textContent).toBe(locale === "en" ? "New" : "신규");
  });

  it("drops the tag for good after a picker click", async () => {
    await mount("precision");
    const inkwell = tiles().find((button) => button.querySelector(".font-medium")?.textContent === "Inkwell")!;
    await act(async () => inkwell.click());
    await act(async () => applySkin("precision"));
    expect(tagged()).toEqual(["Graphite", "Moss"]);
    await act(async () => root.unmount());
    await render();
    expect(tagged()).toEqual(["Graphite", "Moss"]);
  });

  it("drops the tag after the theme hotkey applies it", async () => {
    await mount("precision");
    await act(async () => applySkin(nextSkin("folio")));
    await act(async () => applySkin("precision"));
    expect(tagged()).toEqual(["Graphite", "Moss"]);
  });

  it("drops the tag for a theme started on", async () => {
    await mount("moss");
    await act(async () => applySkin("precision"));
    expect(tagged()).toEqual(["Inkwell", "Graphite"]);
  });
});
