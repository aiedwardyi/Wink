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

async function renderView(devices = DEVICES) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ devices })));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(YourPcs))));
  return { host, root };
}

const rows = (host: Element) => [...host.querySelectorAll("[data-account-row]")];

const nameText = (row: Element, name: string) => {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) if (walker.currentNode.textContent?.includes(name)) return walker.currentNode;
  return null;
};

describe("Your PCs", () => {
  it("this pc not listed under your pcs", async () => {
    const { host, root } = await renderView();
    expect(rows(host).map((row) => row.querySelector("[data-device-name]")?.textContent)).toEqual(["Home", "Laptop", "Den"]);
    expect(host.textContent).not.toContain("This PC");
    await act(async () => root.unmount());
  });

  it("hides with no other PCs", async () => {
    const { host, root } = await renderView(DEVICES.slice(0, 1));
    expect(host.querySelector("[data-your-pcs]")).toBeNull();
    await act(async () => root.unmount());
  });

  it("check only on online pcs, before the name", async () => {
    const { host, root } = await renderView();
    expect(rows(host).map((row) => row.querySelectorAll('[aria-label="Online"]').length)).toEqual([1, 0, 0]);
    const home = rows(host)[0]!;
    const check = home.querySelector('[aria-label="Online"]')!;
    expect(check.closest(".usage-control")).toBeNull();
    expect(check.compareDocumentPosition(nameText(home, "Home")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rows(host).map((row) => row.textContent)).toEqual(["HomeOpen", "LaptopOffline", "DenChecking"]);
    await act(async () => root.unmount());
  });

  it("open uses primary style", async () => {
    const open = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("ogb", { deviceWindow: { open } });
    const { host, root } = await renderView();
    const [home, laptop, den] = rows(host);
    expect(home!.querySelector("button")?.className).toContain("bg-accent");
    expect(laptop!.querySelector("button")).toBeNull();
    expect(den!.querySelector("button")).toBeNull();
    await act(async () => home!.querySelector("button")!.click());
    expect(open).toHaveBeenCalledWith("home.wink.test", "Home");
    await act(async () => root.unmount());
  });

  it("speaks Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const { host, root } = await renderView();
    expect(host.textContent).toContain("내 PC");
    expect(rows(host)[0]?.textContent).toBe("Home열기");
    await act(async () => root.unmount());
  });

  it("paints the last list before the PC answers, then updates it in place", async () => {
    localStorage.setItem("omb-devices", JSON.stringify(DEVICES));
    let answer = (_: Response) => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(YourPcs))));
    expect(rows(host).map((row) => row.textContent)).toEqual(["HomeOpen", "LaptopOffline", "DenChecking"]);
    const first = rows(host)[0];
    await act(async () => answer(Response.json({ devices: DEVICES.map((device) => ({ ...device, offline: false, checking: false })) })));
    expect(rows(host).map((row) => row.textContent)).toEqual(["HomeOpen", "LaptopOpen", "DenOpen"]);
    expect(rows(host)[0]).toBe(first);
    expect(JSON.parse(localStorage.getItem("omb-devices")!)[2].offline).toBe(false);
    await act(async () => root.unmount());
  });

  it("holds one quiet row before the first answer with nothing saved", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(YourPcs))));
    expect(rows(host)).toHaveLength(1);
    expect(rows(host)[0]!.textContent!.trim()).toBe("");
    expect(host.querySelector(".animate-spin, .animate-pulse")).toBeNull();
    await act(async () => root.unmount());
  });
});
