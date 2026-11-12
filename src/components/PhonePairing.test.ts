// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { api } from "@/state/store";
import { PhonePairing } from "./PhonePairing";

const request = vi.fn<typeof api>();
const HOST = "abcdefghijklmnop.wink.test";

function serve(routes: Record<string, (init?: RequestInit) => Awaited<ReturnType<typeof api>>>) {
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${path}`];
    if (!route) throw new Error(`no route ${init?.method ?? "GET"} ${path}`);
    return route(init);
  });
}

afterEach(() => {
  request.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function renderView(onPaired = vi.fn(), onClose = vi.fn()) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(PhonePairing, { request, onPaired, onClose }))));
  return { host, root };
}

const click = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const button = (host: Element, name: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name)!;

describe("PhonePairing", () => {
  it("opens on a QR and a 6 digit code, and cancels it", async () => {
    const url = `https://${HOST}/pair#k=wkp_${"x".repeat(43)}`;
    const cancel = vi.fn(() => ({ ok: true }));
    const onClose = vi.fn();
    serve({
      "GET /api/phone/devices": () => ({ phones: [] }),
      "POST /api/phone/pairing": () => ({ url, code: "123456", expiresAt: Date.now() + 120_000 }),
      "DELETE /api/phone/pairing": cancel,
    });
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const { host, root } = await renderView(vi.fn(), onClose);
    expect(host.querySelector('[aria-label="Phone Pairing QR Code"] svg')).not.toBeNull();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(host.querySelector("[data-pairing-code]")?.textContent).toBe("123456");
    expect(host.textContent).toMatch(/Expires in [12]:\d\d/);
    expect(host.textContent).not.toContain("wkp_");
    await act(async () => click(button(host, "Cancel")));
    expect(cancel).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("names the phone that used the code and refreshes the list", async () => {
    vi.useFakeTimers();
    let phones: { id: string; name: string }[] = [{ id: "p1", name: "Pixel" }];
    const onPaired = vi.fn();
    serve({
      "GET /api/phone/devices": () => ({ phones }),
      "POST /api/phone/pairing": () => ({ url: `https://${HOST}/pair#k=x`, code: "123456", expiresAt: Date.now() + 120_000 }),
    });
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const { host, root } = await renderView(onPaired);
    phones = [...phones, { id: "p2", name: "iPhone" }];
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(host.textContent).toContain("iPhone is paired.");
    expect(onPaired).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("says so when the PC cannot make a code", async () => {
    serve({ "GET /api/phone/devices": () => ({ phones: [] }) });
    const { host, root } = await renderView();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not make a pairing code.");
    expect(button(host, "Make a New Code")).toBeDefined();
    await act(async () => root.unmount());
  });
});
