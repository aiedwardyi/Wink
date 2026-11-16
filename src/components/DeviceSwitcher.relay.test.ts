// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { SIDEBAR_COLLAPSED_KEY } from "@/lib/sidebar-preferences";
import { StoreProvider } from "@/state/store";

import { Sidebar } from "./Sidebar";

let host: HTMLDivElement;
let root: Root;
let roster: unknown[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class {
    onmessage = null;
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (String(path).includes("/api/devices")) return new Response(JSON.stringify({ devices: roster }));
    if (String(path).includes("/api/bots")) return new Response(JSON.stringify({ bots: [], groups: [], computerControl: {} }));
    return new Response("{}", { status: 200 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.clear();
  delete window.ogb;
  roster = [];
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  applyLocale("en");
  delete window.ogb;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderSidebar(hostname: string, phone = false, collapsed = false, locale: "en" | "ko" = "en") {
  vi.stubGlobal("location", new URL(`https://${hostname}/`));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  applyLocale(locale);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} }))));
  await act(async () => {
    await Promise.all(vi.mocked(fetch).mock.results.map((result) => result.value));
  });
}

const roster3 = [
  { deviceId: "home", name: "Edward's Home Workstation", host: "aaaaaaaaaaaaaaaa.wink.edwardyi.dev", current: true, offline: false },
  { deviceId: "laptop", name: "Edward's Travel Laptop", host: "cccccccccccccccc.wink.edwardyi.dev", current: false, offline: true, laptop: true },
  { deviceId: "work", name: "Edward's Office Desktop", host: "bbbbbbbbbbbbbbbb.wink.edwardyi.dev", current: false, offline: false },
];

async function openMenu() {
  const button = document.querySelector("[data-device-switcher] button");
  expect(button).not.toBeNull();
  await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  return document.querySelector("[data-device-id]")?.closest("ul") ?? document.querySelector("[data-pc-picker]")?.closest("ul");
}

describe("relay PC switching", () => {
  it.each([
    ["en", false, false], ["en", true, false], ["en", true, true],
    ["ko", false, false], ["ko", true, false], ["ko", true, true],
  ] as const)("keeps the chooser as the last menu item without a device roster (%s, phone %s, collapsed %s)", async (locale, phone, collapsed) => {
    await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev", phone, collapsed, locale);
    expect(document.querySelector("[data-sidebar-footer] [data-pc-picker]")).toBeNull();
    const menu = await openMenu();
    const link = menu?.lastElementChild?.querySelector<HTMLAnchorElement>("[data-pc-picker]");
    expect(link?.getAttribute("href")).toBe("https://wink.edwardyi.dev/?pick=1");
    expect(link?.textContent).toBe(locale === "ko" ? "다른 PC 선택…" : "Choose another PC…");
  });

  it.each([false, true])("switches PC from the top icon only (phone %s)", async (phone) => {
    roster = roster3;
    const leave = vi.fn();
    window.addEventListener("orbit:leave", leave);
    try {
      await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev", phone);
      expect(document.querySelectorAll("[data-device-switcher]")).toHaveLength(1);
      expect(document.querySelector("[data-device-switcher]")?.closest("[data-sidebar-footer]")).toBeNull();
      expect(document.querySelector("[data-pc-picker]")).toBeNull();
      const menu = await openMenu();
      expect(menu?.querySelector("[data-device-id=home]")?.textContent).toContain("This PC");
      expect(menu?.querySelector("[data-device-id=laptop]")?.textContent).toContain("Offline");
      expect(menu?.querySelector("[data-connect-device]")).toBeNull();
      expect(menu?.lastElementChild?.querySelector("[data-pc-picker]")).not.toBeNull();
      expect(document.querySelectorAll("[data-pc-picker]")).toHaveLength(1);
      await act(async () => menu?.querySelector("[data-device-id=work]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(leave).toHaveBeenCalledTimes(1);
      expect(leave.mock.calls[0][0].detail).toBe("https://bbbbbbbbbbbbbbbb.wink.edwardyi.dev/");
    } finally {
      window.removeEventListener("orbit:leave", leave);
    }
  });

  it.each(["localhost", "wink.edwardyi.dev", "aaaaaaaaaaaaaaaa.tail1234.ts.net"])("offers no chooser on %s", async (hostname) => {
    roster = roster3;
    await renderSidebar(hostname);
    await openMenu();
    expect(document.querySelector("[data-pc-picker]")).toBeNull();
  });

  it("offers no chooser in the native app", async () => {
    roster = roster3;
    window.ogb = { deviceWindow: { open: vi.fn() } } as never;
    await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev");
    await openMenu();
    expect(document.querySelector("[data-pc-picker]")).toBeNull();
  });
});
