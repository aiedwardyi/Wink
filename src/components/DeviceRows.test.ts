// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { YourPcs } from "./DeviceRows";

const DEVICES = [
  { deviceId: "a", name: "Workstation upstairs by the window", host: "work.wink.test", current: true, offline: false },
  { deviceId: "b", name: "Home", host: "home.wink.test", current: false, offline: false },
  { deviceId: "c", name: "Laptop", host: "laptop.wink.test", current: false, offline: true },
  { deviceId: "d", name: "Den", host: "den.wink.test", current: false, offline: false, checking: true },
];

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function renderView() {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ devices: DEVICES })));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(YourPcs))));
  return { host, root };
}

const rows = (host: Element) => [...host.querySelectorAll("[data-account-row]")];

describe("Your PCs", () => {
  it("checks only the PCs that are online, and opens one from its row", async () => {
    const open = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("ogb", { deviceWindow: { open } });
    const { host, root } = await renderView();
    expect(rows(host).map((row) => row.querySelector('[aria-label="Online"]') !== null)).toEqual([true, true, false, false]);
    await act(async () => rows(host)[1]!.querySelector("button")!.click());
    expect(open).toHaveBeenCalledWith("home.wink.test", "Home");
    await act(async () => root.unmount());
  });

  it("green check sits after the name", async () => {
    const { host, root } = await renderView();
    expect(rows(host).map((row) => row.textContent)).toEqual([`${DEVICES[0]!.name}This PC`, "HomeOpen", "LaptopOffline", "DenChecking"]);
    for (const row of rows(host).slice(0, 2)) {
      const check = row.querySelector('[aria-label="Online"]')!;
      expect(check.closest(".usage-control")).toBeNull();
      expect(check.closest("[data-device-name]")?.textContent).toBe(row.querySelector("[data-device-name]")?.textContent);
    }
    await act(async () => root.unmount());
  });

  it("speaks Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const { host, root } = await renderView();
    expect(host.textContent).toContain("내 PC");
    expect(rows(host)[1]?.textContent).toBe("Home열기");
    await act(async () => root.unmount());
  });
});
