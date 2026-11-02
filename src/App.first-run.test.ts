// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

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

async function toFinalStep() {
  await act(async () => root.render(createElement(App)));
  const next = await until(() => { const found = button("Continue"); return found && !found.disabled ? found : null; });
  await act(async () => next!.click());
  expect(await until(star)).toBeDefined();
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/instances")) return Promise.resolve(new Response(JSON.stringify({ instances: [claude] })));
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

  it("asks about analytics with nothing chosen and saves only an explicit pick", async () => {
    await toFinalStep();
    const yes = button("Yes")!;
    const no = button("No")!;
    expect(yes.getAttribute("aria-checked")).toBe("false");
    expect(no.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).not.toBe(yes);
    expect(analyticsPuts()).toHaveLength(0);

    await act(async () => no.click());
    expect(no.getAttribute("aria-checked")).toBe("true");
    expect(analyticsPuts().map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ enabled: false }]);
    await act(async () => button("Open Wink")!.click());
    expect(analyticsPuts()).toHaveLength(1);
  });
});
