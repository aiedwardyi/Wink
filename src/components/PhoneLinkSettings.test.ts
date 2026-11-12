// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => store);
const relay = vi.hoisted(() => ({ on: true }));
vi.mock("./PhoneAccessSettings", () => ({
  PhoneAccessSettings: ({ onEnabled }: { onEnabled?: (on: boolean) => void }) => {
    useEffect(() => onEnabled?.(relay.on), [onEnabled]);
    return createElement("div", { "data-this-pc": true });
  },
}));
vi.mock("./DeviceRows", async (original) => ({ ...await original<typeof import("./DeviceRows")>(), YourPcs: () => null }));

import { I18nProvider } from "@/lib/i18n";
import { PhoneLinkSettings } from "./PhoneLinkSettings";

const url = "https://fixture.invalid/remote?key=fixture";
let root: Root | undefined;
let host: HTMLDivElement;
const button = (label: string) => [...host.querySelectorAll("button, a")].find((node) => node.textContent === label) as HTMLElement;
const openTailscale = async () => {
  await act(async () => host.querySelector<HTMLElement>('[aria-controls="devices-other"]')!.click());
  await act(async () => host.querySelector<HTMLElement>('[aria-controls="devices-tailscale"]')!.click());
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("omb-locale", "en");
  host = document.body.appendChild(document.createElement("div"));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  store.api.mockReset();
  relay.on = true;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function render(body: object) {
  store.api.mockResolvedValue(body);
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
  if (host.querySelector('[aria-controls="devices-other"]')) await openTailscale();
}

describe("Phone setup steps", () => {
  it("keeps both QR sections in a narrow desktop window", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("ogb", { platform: "win32" });
    await render({ url, setup: { state: "ready" } });
    expect(host.querySelector("[data-store-codes]")).not.toBeNull();
    expect(host.querySelector("[data-phone-link-qr]")).not.toBeNull();
  });

  it("does not probe PC-only relay status from a remote phone", async () => {
    vi.stubGlobal("ogb", undefined);
    vi.stubGlobal("location", { hostname: "pc.fixture.ts.net" });
    await render({ url, setup: { state: "ready" } });
    expect(store.api.mock.calls.some(([path]) => path === "/api/phone-relay/status")).toBe(false);
  });

  it("probes twice a minute while ready and slowly while offline", async () => {
    await render({ url, setup: { state: "ready" } });
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.api.mock.calls.filter(([path]) => path === "/api/remote-link?setup=1")).toHaveLength(2);
    store.api.mockResolvedValue({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    await act(async () => window.dispatchEvent(new Event("focus")));
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.api.mock.calls.filter(([path]) => path === "/api/remote-link?setup=1")).toHaveLength(10);
  });

  it.each(["Get Tailscale", "Sign In"])("caps fast polling after %s", async (action) => {
    vi.stubGlobal("ogb", { openExternal: vi.fn().mockResolvedValue(true) });
    const body = { url: null, setup: action === "Sign In" ? { state: "not-running", backendState: "NeedsLogin" } : { state: "missing" } };
    await render(body);
    store.api.mockImplementation(async (path: string) => path === "/api/devices/sign-in" ? { url: "https://login.tailscale.com/a/fixture" } : body);
    await act(async () => button(action).click());
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.api).toHaveBeenCalledTimes(30);
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.api).toHaveBeenCalledTimes(10);
  });

  it("keeps ready probes slow without a redundant Tailscale download", async () => {
    vi.stubGlobal("ogb", { openExternal: vi.fn().mockResolvedValue(true) });
    await render({ url, setup: { state: "ready", account: "you@example.com" } });
    expect(host.querySelector("[data-pc-ready]")?.textContent).toContain("Signed in as you@example.com");
    expect(host.querySelector("[data-pc-ready]")?.textContent).not.toContain("Get Tailscale");
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(store.api.mock.calls.filter(([path]) => path === "/api/remote-link?setup=1")).toHaveLength(2);
  });

  it("stops fast polling when the setup state changes", async () => {
    vi.stubGlobal("ogb", { openExternal: vi.fn().mockResolvedValue(true) });
    await render({ url: null, setup: { state: "missing" } });
    await act(async () => button("Get Tailscale").click());
    store.api.mockResolvedValue({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    store.api.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(store.api).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false])("shows and copies a usable phone link without discovery (%s)", async (phoneJoined) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render({ url, setup: { state: "ready", phoneJoined } });
    expect(host.querySelector("[data-phone-link-qr]")).not.toBeNull();
    await act(async () => button("Copy Link").click());
    expect(writeText).toHaveBeenCalledWith(url);
  });

  it("sends a phone to the PC for Tailscale sign-in", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("location", { hostname: "pc.fixture.ts.net" });
    await render({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    expect(button("Sign In")).toBeUndefined();
    expect(host.textContent).toContain("Sign in on the PC itself.");
  });

  it("keeps Sign In in a narrow desktop window", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("ogb", { openExternal: vi.fn() });
    await render({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    expect(button("Sign In")).toBeDefined();
    expect(host.textContent).not.toContain("Sign in on the PC itself.");
  });

  it("reopens Sign In after the browser closes before completion", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("ogb", { openExternal });
    await render({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    const loginUrl = "https://login.tailscale.com/a/fixture";
    store.api.mockImplementation(async (path: string) => path === "/api/devices/sign-in" ? { url: loginUrl } : { url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    await act(async () => button("Sign In").click());
    expect(host.textContent).toContain("Finish in your browser.");
    expect(button("Sign In")).toBeDefined();
    await act(async () => button("Sign In").click());
    expect(openExternal.mock.calls).toEqual([[loginUrl], [loginUrl]]);
  });

  it.each([false, true])("keeps discovered PC opening in Electron on phone=%s", async (phone) => {
    vi.stubGlobal("ogb", undefined);
    vi.stubGlobal("matchMedia", () => ({ matches: phone }));
    await render({ url, setup: { state: "ready" }, pcs: [{ name: "Laptop", host: "laptop.tail1234.ts.net" }] });
    await act(async () => button("PC").click());
    expect(button("Open Laptop")).toBeUndefined();
    expect(host.textContent).not.toContain("Open Laptop");
    expect(button("Copy Link")).toBeDefined();
  });

  it("refreshes setup when opening a PC finds no local tailnet", async () => {
    const open = vi.fn().mockResolvedValue(false);
    vi.stubGlobal("ogb", { deviceWindow: { open } });
    await render({ url, setup: { state: "ready" }, pcs: [{ name: "Laptop", host: "laptop.tail1234.ts.net" }] });
    await act(async () => button("PC").click());
    store.api.mockResolvedValue({ url: null, setup: { state: "missing" } });
    await act(async () => button("Open Laptop").click());
    expect(store.api).toHaveBeenLastCalledWith("/api/remote-link?setup=1");
    expect(store.api).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-pc-ready]")).toBeNull();
    expect(button("Get Tailscale")).toBeDefined();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Tailscale is offline. Open it and connect.");
  });

  it.each(["Phone", "PC"])("keeps %s steps numbered 1-2 when This PC folds", async (tab) => {
    vi.stubGlobal("ogb", { deviceWindow: { open: vi.fn() } });
    await render({ url: null, setup: { state: "missing" } });
    await act(async () => button(tab).click());
    const numbers = () => [...host.querySelectorAll('[data-devices-settings] > ol:last-child [data-device-step]')].map((row) => row.getAttribute("data-device-step"));
    expect(numbers()).toEqual(["1", "2"]);
    expect(host.querySelectorAll('[data-devices-settings] > ol:first-of-type [data-device-step]')).toHaveLength(3);
    store.api.mockResolvedValue({ url, setup: { state: "ready" } });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("[data-pc-ready]")).not.toBeNull();
    expect(numbers()).toEqual(["1", "2"]);
  });

  it("shows one installer button and mutes every later row while missing", async () => {
    await render({ url: null, setup: { state: "missing" } });
    expect(host.querySelectorAll('a[href="https://tailscale.com/download"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-device-step][data-active="true"]')).toHaveLength(1);
    expect([...host.querySelectorAll("[data-device-step]")].map((row) => row.getAttribute("data-device-step"))).toEqual(["1", "2", "3", "1", "2"]);
  });

  it("opens the login URL once and waits in the browser", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("ogb", { platform: "win32", openExternal });
    await render({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    store.api.mockResolvedValueOnce({ url: "https://login.tailscale.com/a/fixture" });
    await act(async () => button("Sign In").click());
    expect(store.api).toHaveBeenCalledWith("/api/devices/sign-in", { method: "POST" });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://login.tailscale.com/a/fixture");
    expect(button("Sign In")).toBeDefined();
    expect(host.textContent).toContain("Finish in your browser.");
  });

  it("waits for machine approval without a sign-in button", async () => {
    await render({ url: null, setup: { state: "not-running", backendState: "NeedsMachineAuth" } });
    expect(button("Sign In")).toBeUndefined();
    expect(host.textContent).toContain("Waiting for your Tailscale admin to approve this PC.");
    expect(store.api.mock.calls.some(([path]) => path === "/api/devices/sign-in")).toBe(false);
  });

  it("opens Allow once after signing in here and keeps its button reachable", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("ogb", { platform: "win32", openExternal });
    await render({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    store.api.mockResolvedValueOnce({ url: "https://login.tailscale.com/a/fixture" });
    await act(async () => button("Sign In").click());
    const enableUrl = "https://login.tailscale.com/f/serve?node=fixture";
    store.api.mockResolvedValue({ url: null, setup: { state: "serve-disabled", backendState: "Running", enableUrl } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(openExternal).toHaveBeenLastCalledWith(enableUrl);
    expect(button("Allow")).toBeDefined();
    expect(host.textContent).toContain("Click Enable on the Tailscale page.");
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it("keeps sign-in available after its request fails", async () => {
    await render({ url: null, setup: { state: "not-running", backendState: "NeedsLogin" } });
    store.api.mockRejectedValueOnce(new Error("fixture"));
    await act(async () => button("Sign In").click());
    expect(button("Sign In")).toBeDefined();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("opens exactly the Serve enable URL and shows its next instruction", async () => {
    const enableUrl = "https://login.tailscale.com/f/serve?node=fixture";
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("ogb", { openExternal });
    await render({ url: null, setup: { state: "serve-disabled", backendState: "Running", enableUrl } });
    await act(async () => button("Allow").click());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(enableUrl);
    expect(host.textContent).toContain("Click Enable on the Tailscale page.");
  });

  it("shows store buttons and no QR on a phone", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
    vi.stubGlobal("location", { hostname: "pc.fixture.ts.net" });
    await render({ url, setup: { state: "ready" } });
    expect(button("App Store")).toBeDefined();
    expect(button("Google Play")).toBeDefined();
    expect(host.querySelector("[data-store-codes]")).toBeNull();
    expect(host.querySelector("[data-phone-link-qr]")).toBeNull();
  });

  it("keeps the PC paste flow and Copy Link reachable with no phone", async () => {
    const open = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("ogb", { deviceWindow: { open } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render({ url, setup: { state: "ready", account: "you@example.com" }, pcs: [{ name: "Laptop", host: "laptop.tail1234.ts.net" }] });
    await act(async () => button("PC").click());
    expect(host.textContent).toContain("Open Wink there and do the same steps as you@example.com.");
    await act(async () => button("Copy Link").click());
    expect(writeText).toHaveBeenCalledWith(url);
    await act(async () => button("Open Laptop").click());
    expect(open).toHaveBeenCalledExactlyOnceWith("laptop.tail1234.ts.net", "Laptop");
  });

  it.each(["missing", "not-running", "serve-disabled", "checking", "error", "ready"])("renders %s with one next PC step", async (state) => {
    await render({ url, setup: { state, backendState: state === "not-running" ? "NeedsLogin" : undefined, enableUrl: "https://login.tailscale.com/f/serve?node=fixture" } });
    expect(host.querySelectorAll("[data-device-step]")).toHaveLength(state === "ready" ? 2 : 5);
    expect([...host.querySelectorAll("[data-device-step]")].map((row) => Number(row.getAttribute("data-device-step")))).toEqual(state === "ready" ? [1, 2] : [1, 2, 3, 1, 2]);
    expect(!!button("Allow")).toBe(state === "serve-disabled");
    expect(host.textContent).not.toContain(url);
    expect(!!button("Sign In")).toBe(state === "not-running");
    expect(!!host.querySelector("[data-phone-link-qr]")).toBe(state === "ready");
  });

  it("opens Get Tailscale through the desktop external path", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ogb", { platform: "win32", openExternal });
    await render({ url: null, setup: { state: "missing" } });
    await act(async () => button("Get Tailscale").click());
    expect(openExternal).toHaveBeenCalledWith("https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe");
  });

  it("keeps a browser download fallback", async () => {
    vi.stubGlobal("ogb", undefined);
    await render({ url: null, setup: { state: "missing" } });
    expect(button("Get Tailscale").getAttribute("href")).toBe("https://tailscale.com/download");
    expect(button("Get Tailscale").getAttribute("target")).toBe("_blank");
  });

  it("copies the same link encoded by the local QR", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render({ url, setup: { state: "ready", phoneJoined: true } });
    const qr = document.createElement("div");
    qr.innerHTML = renderToStaticMarkup(createElement(QRCodeSVG, { value: url, size: 168, level: "M", bgColor: "#ffffff", fgColor: "#111111" }));
    expect(host.querySelector("[data-phone-link-qr] svg")?.outerHTML).toBe(qr.innerHTML);
    expect(host.querySelector("img")).toBeNull();
    await act(async () => button("Copy Link").click());
    expect(writeText).toHaveBeenCalledWith(url);
    expect(button("Copied")).toBeDefined();
  });

  it("keeps Copied through a focus refresh", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await render({ url, setup: { state: "ready", phoneJoined: true } });
    await act(async () => button("Copy Link").click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button("Copied")).toBeDefined();
  });

  it.each(["not-running", "serve-disabled", "error", "checking"])("keeps Get Tailscale reachable when %s", async (state) => {
    await render({ url: null, setup: { state } });
    expect(button("Get Tailscale")).toBeDefined();
  });

  it("leads with this PC and folds pairing and Tailscale behind their buttons", async () => {
    store.api.mockResolvedValue({ url: null, setup: { state: "missing" } });
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    expect(host.querySelector("[data-this-pc]")).not.toBeNull();
    expect(host.querySelector("[data-phone-pairing]")).toBeNull();
    expect(host.querySelector("[data-devices-settings]")).toBeNull();
    expect(store.api.mock.calls.some(([path]) => path === "/api/remote-link?setup=1")).toBe(false);
    await act(async () => button("Other ways to connect").click());
    const pair = button("Get Code");
    await act(async () => pair.click());
    expect(document.getElementById(pair.getAttribute("aria-controls")!)?.querySelector("[data-phone-pairing]")).not.toBeNull();
    await act(async () => button("Set Up").click());
    expect(document.getElementById("devices-tailscale")?.querySelector("[data-devices-settings]")).not.toBeNull();
  });

  it("one fold holds code and tailscale", async () => {
    store.api.mockResolvedValue({ url: null, setup: { state: "missing" } });
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    const fold = button("Other ways to connect");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(button("Get Code")).toBeUndefined();
    await act(async () => fold.click());
    const body = document.getElementById(fold.getAttribute("aria-controls")!)!;
    for (const text of ["Code instead of Google", "For someone without your Google account. Needs this PC on.", "Tailscale", "Your own private network. Install Tailscale on each device."]) expect(body.textContent).toContain(text);
    expect(button("Pair with a code")).toBeUndefined();
    expect(button("Use Tailscale instead")).toBeUndefined();
    await act(async () => button("Get Code").click());
    expect(body.querySelector("[data-phone-pairing]")).not.toBeNull();
    await act(async () => button("Set Up").click());
    expect(body.querySelector("[data-devices-settings]")).not.toBeNull();
  });

  it("get code disabled while off", async () => {
    relay.on = false;
    store.api.mockResolvedValue({ url: null, setup: { state: "missing" } });
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    await act(async () => button("Other ways to connect").click());
    expect((button("Get Code") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Set Up") as HTMLButtonElement).disabled).toBe(false);
    expect(store.api.mock.calls.some(([path]) => path === "/api/phone/pairing")).toBe(false);
  });

  it("keeps the Tailscale page on a remote device, with no relay parts", async () => {
    vi.stubGlobal("location", { hostname: "pc.fixture.ts.net" });
    await render({ url, setup: { state: "ready", phoneJoined: true } });
    expect(host.querySelector("[data-devices-settings]")).not.toBeNull();
    expect(host.querySelector("[data-this-pc]")).toBeNull();
    expect(button("Other ways to connect")).toBeUndefined();
  });

  it.each(["focus", "poll"])("refreshes on %s even after ready and stops on unmount", async (trigger) => {
    await render({ url, setup: { state: "ready", phoneJoined: true } });
    store.api.mockResolvedValue({ url: null, setup: { state: "not-running" } });
    await act(async () => {
      if (trigger === "focus") window.dispatchEvent(new Event("focus"));
      else await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(host.querySelector("[data-phone-link-qr]")).toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    const count = store.api.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.api).toHaveBeenCalledTimes(count);
  });

  it("does not overlap slow requests and ignores a result after unmount", async () => {
    let finish!: (body: object) => void;
    store.api.mockImplementation((path: string) => path === "/api/remote-link?setup=1" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    await openTailscale();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(store.api.mock.calls.filter(([path]) => path === "/api/remote-link?setup=1")).toHaveLength(1);
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => finish({ url, setup: { state: "ready", phoneJoined: true } }));
    expect(host.textContent).toBe("");
  });

  it("clears a ready QR if the request fails", async () => {
    await render({ url, setup: { state: "ready", phoneJoined: true } });
    store.api.mockRejectedValue(new Error("fixture"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("[data-phone-link-qr]")).toBeNull();
    expect(host.textContent).toContain("Wink will retry.");
  });

  it("pauses requests in a background window and rechecks when visible", async () => {
    await render({ url: null, setup: { state: "checking" } });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const count = store.api.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(store.api).toHaveBeenCalledTimes(count);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(store.api).toHaveBeenCalledTimes(count + 1);
  });

  it("keeps phone joined and Wink opened as separate steps", async () => {
    await render({ url, setup: { state: "ready", phoneJoined: true }, phones: [] });
    expect(host.querySelector("[data-phone-list]")).toBeNull();
    expect(host.querySelector('[data-device-step="1"]')?.getAttribute("data-complete")).toBe("true");
    expect(host.querySelector('[data-device-step="2"]')?.getAttribute("data-complete")).toBe("false");
    expect(host.querySelector('[data-device-step="2"]')?.textContent).toContain("2");
  });

  it.each([
    ["en", ["Android phone · Active 5m ago", "iPhone · Active now", "Phone · Active 3d ago", "iPad · Active 2h ago"], "A phone has opened Wink"],
    ["ko", ["Android 휴대폰 · 5분 전 사용", "iPhone · 지금 사용 중", "휴대폰 · 3일 전 사용", "iPad · 2시간 전 사용"], "휴대폰에서 Wink를 열었습니다"],
  ])("lists phones and checks every step in %s", async (locale, rows, label) => {
    localStorage.setItem("omb-locale", locale);
    vi.setSystemTime(1_800_000_000_000);
    const ago = (ms: number) => 1_800_000_000_000 - ms;
    await render({ url, setup: { state: "ready", phoneJoined: true }, phones: [
      { id: "a", kind: "android", lastSeen: ago(5 * 60_000) },
      { id: "b", kind: "iphone", lastSeen: ago(30_000) },
      { id: "c", kind: "phone", lastSeen: ago(3 * 86_400_000) },
      { id: "d", kind: "ipad", lastSeen: ago(2 * 3_600_000) },
    ] });
    expect([...host.querySelectorAll("[data-phone-list] li")].map((row) => row.textContent)).toEqual(rows);
    for (const step of ["1", "2"]) expect(host.querySelector(`[data-device-step="${step}"]`)?.getAttribute("data-complete")).toBe("true");
    expect(host.querySelectorAll(`[aria-label="${label}"]`)).toHaveLength(2);
    expect(host.querySelector("[data-phone-link-qr] svg")).not.toBeNull();
    expect(host.textContent).not.toMatch(/Mozilla|\d+\.\d+\.\d+\.\d+/);
  });

  it("shows a phone as soon as the next refresh sees it", async () => {
    await render({ url, setup: { state: "ready", phoneJoined: true } });
    expect(host.querySelector("[data-phone-list]")).toBeNull();
    store.api.mockResolvedValue({ url, setup: { state: "ready", phoneJoined: true }, phones: [{ id: "a", kind: "android", lastSeen: Date.now() }] });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("[data-phone-list]")?.textContent).toBe("Android phone · Active now");
    expect(host.querySelector('[data-device-step="2"]')?.getAttribute("data-complete")).toBe("true");
  });

  it("renders all new steps and both rows in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    store.api.mockResolvedValue({ url, setup: { state: "ready", phoneJoined: true } });
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(PhoneLinkSettings))));
    await openTailscale();
    for (const text of ["다른 연결 방법", "Google 대신 코드로 연결", "코드 받기", "나만의 사설 네트워크입니다. 기기마다 Tailscale을 설치하세요.", "설정", "이 PC", "휴대폰에 Tailscale 설치", "스캔해서 Wink 열기", "링크 복사"]) expect(host.textContent).toContain(text);
  });
});
