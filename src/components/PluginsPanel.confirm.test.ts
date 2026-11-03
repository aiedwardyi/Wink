// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { CONNECTED_APPS_CACHE_KEY } from "@/lib/connected-apps-cache";

const { api, dispatch } = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api,
  useStore: () => ({ state: {}, dispatch }),
}));

import { PluginsPanel } from "./PluginsPanel";

it("keeps account confirmation in Korean and owns focus above the Connected Apps modal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("ko");
  api.mockImplementation(async (path: string) => path.endsWith("/catalog")
    ? { configured: true, mode: "managed", cards: [{ slug: "gmail", label: "Gmail", blurb: "Mail", logo: null, domain: null }] }
    : path.endsWith("/connected")
      ? { authoritative: true, services: { gmail: { connected: true, accounts: [{ id: "ca_work", alias: "work", status: "ACTIVE" }] } } }
      : {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const confirmation = () => document.querySelector('[role="dialog"][aria-describedby]');
  const button = (label: string) => [...confirmation()!.querySelectorAll("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(createElement(PluginsPanel)));
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
    const disconnect = host.querySelector<HTMLButtonElement>('button[aria-label="Gmail에서 work 연결 해제"]')!;
    disconnect.focus();
    api.mockClear();
    await act(async () => disconnect.click());
    expect(confirmation()?.textContent).toContain("다른 Gmail 계정은 연결된 상태로 유지됩니다.");
    expect(document.activeElement).toBe(button("취소"));
    expect(api).not.toHaveBeenCalled();

    button("연결 해제").focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    button("연결 해제").dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button("연결 해제"));
    await act(async () => button("연결 해제").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(confirmation()).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(disconnect);
    expect(api).not.toHaveBeenCalled();

    await act(async () => disconnect.click());
    await act(async () => button("취소").click());
    expect(api).not.toHaveBeenCalled();
    await act(async () => disconnect.click());
    await act(async () => button("연결 해제").click());
    expect(api.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
    expect(api).toHaveBeenCalledWith("/api/connectors/gmail/accounts/ca_work", { method: "DELETE" });
    expect(confirmation()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    applyLocale("en");
    vi.unstubAllGlobals();
  }
});

it.each(["live", "offline"])("rechecks disk inventory after a failed preload with a %s result", async (result) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetModules();
  const { PluginsPanel, preloadConnectedApps } = await import("./PluginsPanel");
  const services = { gmail: { connected: true, accounts: [{ id: "ca_work", alias: "work", status: "ACTIVE" }] } };
  const snapshot = JSON.stringify({ at: 1, services });
  localStorage.setItem(CONNECTED_APPS_CACHE_KEY, snapshot);
  api.mockRejectedValue(new Error("startup offline"));
  await preloadConnectedApps();
  api.mockReset();
  let resolve: (value: unknown) => void = () => {};
  let reject: (cause: Error) => void = () => {};
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  void pending.catch(() => {});
  api.mockImplementation((path: string) => path.endsWith("/connected")
    ? pending
    : Promise.resolve({ configured: true, mode: "managed", cards: [{ slug: "gmail", label: "Gmail", blurb: "Mail", logo: null, domain: null }] }));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const checks = () => api.mock.calls.filter(([path]) => path === "/api/connectors/connected");
  try {
    await act(async () => root.render(createElement(PluginsPanel)));
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
    expect.soft(checks()).toHaveLength(1);
    expect.soft(host.textContent).toContain("work");
    expect.soft(host.textContent).not.toContain("Checking connected apps");
    expect.soft(host.textContent).toContain("Showing the last known connections");
    expect.soft(localStorage.getItem(CONNECTED_APPS_CACHE_KEY)).toBe(snapshot);
    await act(async () => {
      if (result === "live") resolve({ services: {} });
      else reject(new Error("still offline"));
      await preloadConnectedApps();
    });
    if (result === "live") {
      expect.soft(host.textContent).not.toContain("work");
      expect.soft(host.textContent).not.toContain("Showing the last known connections");
      expect.soft(JSON.parse(localStorage.getItem(CONNECTED_APPS_CACHE_KEY)!).services).toEqual({});
    } else {
      expect.soft(host.textContent).toContain("work");
      expect.soft(host.textContent).toContain("Showing the last known connections");
      expect.soft(localStorage.getItem(CONNECTED_APPS_CACHE_KEY)).toBe(snapshot);
    }
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(PluginsPanel)));
    expect.soft(checks()).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.removeItem(CONNECTED_APPS_CACHE_KEY);
    api.mockReset();
    vi.unstubAllGlobals();
  }
});
