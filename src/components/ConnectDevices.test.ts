// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);

const body = {
  url: "https://fixture.invalid/remote?key=fixture",
  setup: { state: "ready", backendState: "Running", account: "devices.fixture@example.invalid", phoneJoined: true },
  phones: [{ id: "fixture", kind: "iphone", lastSeen: Date.now() }],
};
let root: Root | undefined;
let host: HTMLDivElement;
let ConnectDevices: typeof import("./ConnectDevices").ConnectDevices;
let I18nProvider: typeof import("@/lib/i18n").I18nProvider;
const open = () => act(async () => {
  root = createRoot(host);
  root.render(createElement(I18nProvider, null, createElement(ConnectDevices)));
});
const close = () => act(async () => { root?.unmount(); root = undefined; });
const delayed = () => store.api.mockImplementation(() => new Promise((resolve) => window.setTimeout(() => resolve(body), 300)));

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", { hostname: "pc.fixture.ts.net" });
  vi.stubGlobal("ogb", undefined);
  localStorage.setItem("omb-locale", "en");
  host = document.body.appendChild(document.createElement("div"));
  ({ ConnectDevices } = await import("./ConnectDevices"));
  ({ I18nProvider } = await import("@/lib/i18n"));
});

afterEach(async () => {
  await close();
  host.remove();
  store.api.mockReset();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Devices first paint", () => {
  it("paints the last answer on reopen while the API is delayed", async () => {
    store.api.mockResolvedValue(body);
    await open();
    const previous = host.innerHTML;
    await close();
    delayed();
    await open();
    expect(host.innerHTML).toBe(previous);
    expect(host.querySelector("[data-pc-ready]")).not.toBeNull();
    expect(host.querySelector("[data-phone-list]")?.textContent).toContain("iPhone");
    expect(host.querySelector('[data-device-step][data-complete="false"]')).toBeNull();
  });

  it("renders no marks or step lists before the first answer", async () => {
    delayed();
    await open();
    expect(host.querySelector("[data-device-step], [data-pc-ready], ol")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(host.querySelector("[data-pc-ready]")).not.toBeNull();
  });

  it("keeps Devices and the PC failure alert visible during the refresh probe", async () => {
    const openPc = vi.fn().mockResolvedValue(false);
    const pc = { name: "Laptop", host: "laptop.fixture.invalid" };
    vi.stubGlobal("ogb", { deviceWindow: { open: openPc } });
    store.api.mockResolvedValue({ ...body, pcs: [pc] });
    await open();
    const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;
    await act(async () => button("PC").click());
    store.api.mockReset();
    store.api.mockImplementation(() => new Promise(() => {}));
    await act(async () => button("Open Laptop").click());
    expect(openPc).toHaveBeenCalledExactlyOnceWith(pc.host, pc.name);
    expect(store.api.mock.calls).toEqual([["/api/remote-link?setup=1"]]);
    expect(host.querySelector("[data-devices-settings]")).not.toBeNull();
    expect(host.querySelector("[data-pc-ready]")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Tailscale is offline. Open it and connect.");
  });

  it("requests the cached answer first and probes immediately after it", async () => {
    delayed();
    await open();
    expect(store.api.mock.calls).toEqual([["/api/remote-link?setup=1&cached=1"]]);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(store.api.mock.calls).toEqual([["/api/remote-link?setup=1&cached=1"], ["/api/remote-link?setup=1"]]);
  });

  it("probes after a failed cached request and keeps the existing error state", async () => {
    store.api.mockRejectedValueOnce(new Error("fixture"));
    delayed();
    await open();
    expect(store.api.mock.calls).toEqual([["/api/remote-link?setup=1&cached=1"], ["/api/remote-link?setup=1"]]);
    expect(host.querySelector('[data-device-step="1"]')?.getAttribute("data-complete")).toBe("true");
    expect(host.querySelector("[data-pc-ready]")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(host.querySelector("[data-pc-ready]")).not.toBeNull();
  });

  it("does not retain a late answer after closing", async () => {
    delayed();
    await open();
    await close();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    store.api.mockClear();
    await open();
    expect(host.querySelector("[data-pc-ready], [data-device-step]")).toBeNull();
    expect(store.api).toHaveBeenCalledTimes(1);
  });

  it("keeps phone links out of persistent storage", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    store.api.mockResolvedValue(body);
    await open();
    await close();
    await open();
    expect(local.mock.calls.some(([, value]) => String(value).includes(body.url))).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps periodic probes, focus refresh and hidden-page polling", async () => {
    store.api.mockResolvedValue(body);
    await open();
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.api.mock.calls.filter(([path]) => path === "/api/remote-link?setup=1")).toHaveLength(2);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(store.api).toHaveBeenLastCalledWith("/api/remote-link?setup=1");
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(store.api).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(store.api).toHaveBeenCalledExactlyOnceWith("/api/remote-link?setup=1");
  });

  it("refreshes incomplete setup every six seconds", async () => {
    store.api.mockResolvedValue({ url: null, setup: { state: "missing" } });
    await open();
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.api).toHaveBeenCalledTimes(10);
    expect(store.api.mock.calls.every(([path]) => path === "/api/remote-link?setup=1")).toBe(true);
  });

  it.each([
    ["en", "This PC", "Signed in as devices.fixture@example.invalid", "Copy Link", "Get Tailscale"],
    ["ko", "이 PC", "devices.fixture@example.invalid 계정으로 로그인됨", "링크 복사", "Tailscale 받기"],
  ])("keeps %s text for ready and missing setup", async (locale, pc, account, copy, install) => {
    localStorage.setItem("omb-locale", locale);
    store.api.mockResolvedValue(body);
    await open();
    expect(host.querySelector("[data-pc-ready]")?.textContent).toContain(pc);
    expect(host.querySelector("[data-pc-ready]")?.textContent).toContain(account);
    expect(host.textContent).toContain(copy);
    store.api.mockResolvedValue({ url: null, setup: { state: "missing" } });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.textContent).toContain(install);
    expect(host.querySelectorAll("[data-device-step]")).toHaveLength(5);
  });
});
