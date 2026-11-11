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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class {
    onmessage = null;
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (String(path).includes("/api/devices")) return new Response(JSON.stringify({ devices: [] }));
    if (String(path).includes("/api/bots")) return new Response(JSON.stringify({ bots: [], groups: [], computerControl: {} }));
    return new Response("{}", { status: 200 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.clear();
  delete window.ogb;
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
}

describe("relay PC discovery link", () => {
  it.each([
    ["en", false, false], ["en", false, true], ["en", true, false], ["en", true, true],
    ["ko", false, false], ["ko", false, true], ["ko", true, false], ["ko", true, true],
  ] as const)("keeps the chooser reachable without a device roster (%s, phone %s, collapsed %s)", async (locale, phone, collapsed) => {
    await renderSidebar("aaaaaaaaaaaaaaaa.wink.edwardyi.dev", phone, collapsed, locale);
    const link = host.querySelector<HTMLAnchorElement>("[data-sidebar-footer] [data-pc-picker]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://wink.edwardyi.dev/?pick=1");
    expect(link?.getAttribute("aria-label")).toBe(locale === "ko" ? "다른 PC 선택" : "Choose another PC");
    if (!collapsed) expect(link?.textContent).toContain(locale === "ko" ? "다른 PC 선택" : "Choose another PC");
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
