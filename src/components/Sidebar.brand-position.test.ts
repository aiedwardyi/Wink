// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { StoreProvider } from "@/state/store";
import { Sidebar } from "./Sidebar";

vi.mock("./BrandMark", () => ({ BrandMark: () => createElement("div", { "data-brand-override": "" }, "Wink") }));

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("puts the desktop brand immediately after the expanded sidebar toggle", async () => {
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ bots: [], groups: [] }))));
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Sidebar, { open: false, onClose: () => {} })))));
    const toggle = host.querySelector<HTMLButtonElement>('button[title="Collapse sidebar to avatars"]')!;
    expect(toggle.nextElementSibling?.hasAttribute("data-brand-override")).toBe(true);
    await act(async () => toggle.click());
    expect(host.querySelector("[data-brand-override]")).toBeNull();
    expect(host.querySelector('button[title="Expand sidebar"]')?.nextElementSibling?.hasAttribute("data-board-button")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
