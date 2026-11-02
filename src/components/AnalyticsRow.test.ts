// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { AnalyticsRow } from "./AnalyticsRow";

afterEach(() => { vi.unstubAllGlobals(); });

it("starts off, reads the saved choice and writes only on a click", async () => {
  let saved = false;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") saved = JSON.parse(String(init.body)).enabled;
    return new Response(JSON.stringify({ enabled: saved }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(AnalyticsRow))));
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "PUT")).toBe(true);
    await act(async () => toggle.click());
    expect(saved).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(saved).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});
