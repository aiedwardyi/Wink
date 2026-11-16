// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let bots: { id: string }[];

const claude = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: true }, models: { default: "", options: [] }, install: { login: { args: ["auth", "login"] } },
};
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
async function until<T>(found: () => T | null | undefined) {
  for (let tries = 0; tries < 150 && !found(); tries++) await wait(20);
  return found();
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent === text);
const star = () => [...document.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')].find((node) => node.textContent === "Star on GitHub");
const analyticsPuts = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/analytics" && init?.method === "PUT");
const sent = () => analyticsPuts().map(([, init]) => JSON.parse(String(init.body)));
const cover = () => document.querySelector(".orbit-inset-aware.fixed.inset-0.z-50.bg-app");
const checkbox = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;

async function toFinalStep() {
  await act(async () => root.render(createElement(App)));
  const next = await until(() => { const found = button("Continue"); return found && !found.disabled ? found : null; });
  await act(async () => next!.click());
  expect(await until(star)).toBeDefined();
}

beforeEach(() => {
  localStorage.clear();
  bots = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/instances")) return Promise.resolve(new Response(JSON.stringify({ instances: [claude] })));
    if (url === "/api/bots?messages=0") return Promise.resolve(new Response(JSON.stringify({ bots })));
    if (url === "/api/analytics") return Promise.resolve(new Response(init?.method === "PUT" ? String(init.body) : JSON.stringify({ enabled: false })));
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("first run end", () => {
  it("skips setup for a configured browser and remembers completion", async () => {
    bots = [{ id: "existing" }];
    await act(async () => root.render(createElement(App)));
    expect(await until(() => localStorage.getItem("omb-onboarding-done"))).toBe("true");
    expect(document.querySelector('[aria-labelledby="onboarding-title"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(App)));
    await wait(300);
    expect(document.querySelector('[aria-labelledby="onboarding-title"]')).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/bots?messages=0")).toHaveLength(1);
  });

  it("covers the app while setup loads only on the desktop", async () => {
    // a fresh App each time, so an Onboarding chunk loaded earlier can't skip the fallback
    const fresh = async () => {
      vi.resetModules();
      return (await import("./App")).default;
    };
    const browserApp = await fresh();
    act(() => root.render(createElement(browserApp)));
    expect(cover()).toBeNull();
    await act(async () => root.unmount());
    vi.stubGlobal("ogb", {});
    const desktopApp = await fresh();
    root = createRoot(host);
    act(() => root.render(createElement(desktopApp)));
    expect(cover()).not.toBeNull();
  });

  it("shows Star on GitHub once, then never again", async () => {
    await toFinalStep();
    expect(star()!.href).toBe("https://github.com/aiedwardyi/Wink");
    expect(star()!.target).toBe("_blank");
    await act(async () => button("Open Wink")!.click());
    expect(localStorage.getItem("omb-onboarding-done")).toBe("true");
    expect(star()).toBeUndefined();

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(App)));
    await wait(300);
    expect(document.querySelector('[aria-labelledby="onboarding-title"]')).toBeNull();
    expect(star()).toBeUndefined();
  });

  it("checks usage stats by default and saves it on Open Wink", async () => {
    await toFinalStep();
    expect(checkbox().checked).toBe(true);
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
    expect(analyticsPuts()).toHaveLength(0);
    await act(async () => button("Open Wink")!.click());
    expect(sent()).toEqual([{ enabled: true }]);
  });

  it("saves false after one tap to uncheck", async () => {
    await toFinalStep();
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    expect(analyticsPuts()).toHaveLength(0);
    await act(async () => button("Open Wink")!.click());
    expect(sent()).toEqual([{ enabled: false }]);
  });
});
