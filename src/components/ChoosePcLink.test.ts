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

describe("relay PC discovery link", () => {
  it.each([
    ["en", false], ["en", true], ["ko", false], ["ko", true],
  ] as const)("keeps the chooser in the phone drawer without a device roster (%s, collapsed %s)", async (locale, collapsed) => {
    await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev", true, collapsed, locale);
    const link = host.querySelector<HTMLAnchorElement>("[data-sidebar-footer] [data-pc-picker]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://wink.edwardyi.dev/?pick=1");
    expect(link?.getAttribute("aria-label")).toBe(locale === "ko" ? "다른 PC 선택" : "Choose another PC");
    if (!collapsed) expect(link?.textContent).toContain(locale === "ko" ? "다른 PC 선택" : "Choose another PC");
  });

  it.each([false, true])("drops the bottom chooser in a desktop browser (collapsed %s)", async (collapsed) => {
    await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev", false, collapsed);
    expect(host.querySelector("[data-pc-picker]")).toBeNull();
  });

  it("switches PC from the top icon in a desktop browser", async () => {
    roster = [
      { deviceId: "home", name: "Edward's Home Workstation", host: "aaaaaaaaaaaaaaaa.wink.edwardyi.dev", current: true, offline: false },
      { deviceId: "laptop", name: "Edward's Travel Laptop", host: "cccccccccccccccc.wink.edwardyi.dev", current: false, offline: true, laptop: true },
      { deviceId: "work", name: "Edward's Office Desktop", host: "bbbbbbbbbbbbbbbb.wink.edwardyi.dev", current: false, offline: false },
    ];
    const leave = vi.fn();
    window.addEventListener("orbit:leave", leave);
    try {
      await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev");
      const switcher = host.querySelector("[data-device-switcher]");
      expect(switcher).not.toBeNull();
      expect(switcher?.closest("[data-sidebar-footer]")).toBeNull();
      await act(async () => switcher?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(host.querySelector("[data-device-id=home]")?.textContent).toContain("This PC");
      expect(host.querySelector("[data-device-id=laptop]")?.textContent).toContain("Offline");
      expect(host.querySelector("[data-connect-device]")).toBeNull();
      await act(async () => host.querySelector("[data-device-id=work]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(leave).toHaveBeenCalledTimes(1);
      expect(leave.mock.calls[0][0].detail).toBe("https://bbbbbbbbbbbbbbbb.wink.edwardyi.dev/");
      expect(host.querySelector("[data-pc-picker]")).toBeNull();
    } finally {
      window.removeEventListener("orbit:leave", leave);
    }
  });

  it.each(["localhost", "wink.edwardyi.dev", "aaaaaaaaaaaaaaaa.tail1234.ts.net"])("does not add relay discovery on %s", async (hostname) => {
    await renderSidebar(hostname);
    expect(host.querySelector("[data-pc-picker]")).toBeNull();
  });

  it("does not add relay discovery in the native app", async () => {
    window.ogb = { deviceWindow: { open: vi.fn() } } as never;
    await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev");
    expect(host.querySelector("[data-pc-picker]")).toBeNull();
  });
});
