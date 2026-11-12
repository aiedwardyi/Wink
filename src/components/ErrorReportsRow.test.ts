// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { usageStatsSwitched } from "@/lib/usage-stats";
import { ErrorReportsRow } from "./ErrorReportsRow";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", () => ({ api: request }));
vi.mock("@/lib/usage-stats", async (original) => ({ ...(await original<typeof import("@/lib/usage-stats")>()), usageStatsSwitched: vi.fn() }));
beforeEach(() => request.mockReset().mockResolvedValue({ enabled: false }));
afterEach(() => { delete window.ogb; localStorage.setItem("omb-locale", "en"); vi.useRealTimers(); });

it.each([undefined, {}])("renders nothing without the native consent API (%j)", async (bridge) => {
  Object.defineProperty(window, "ogb", { value: bridge, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    expect(host.innerHTML).toBe("");
  } finally { await act(async () => root.unmount()); }
});

it("keeps usage consent available when crash reporting is unavailable", async () => {
  Object.defineProperty(window, "ogb", { value: { errorReportConsent: async () => null, setErrorReportConsent: vi.fn() }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    expect(host.querySelector('[role="switch"]')).not.toBeNull();
    await act(async () => host.querySelector("button")!.click());
    expect(request).toHaveBeenCalledWith("/api/analytics", { method: "PUT", body: '{"enabled":true}' });
  } finally {
    await act(async () => root.unmount());
  }
});

it("starts unchecked, reads local consent and changes it only on an explicit click", async () => {
  let resolve: (value: boolean) => void = () => {};
  const errorReportConsent = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
  const setErrorReportConsent = vi.fn(async (value: boolean) => value);
  request.mockImplementation(async (_path: string, init?: RequestInit) => (init ? { enabled: init.body === '{"enabled":true}', capture: init.body === '{"enabled":true}', period: 7 } : { enabled: false }));
  Object.defineProperty(window, "ogb", { value: { errorReportConsent, setErrorReportConsent }, configurable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    const toggle = host.querySelector("button")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
    expect(setErrorReportConsent).not.toHaveBeenCalled();
    await act(async () => resolve(false));
    expect(toggle.disabled).toBe(false);
    expect(host.textContent).toContain("Anonymous speed, crash and feature stats. Never chats, files or names.");
    await act(async () => toggle.click());
    expect(setErrorReportConsent).toHaveBeenLastCalledWith(true);
    expect(request).toHaveBeenCalledWith("/api/analytics", { method: "PUT", body: '{"enabled":true}' });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(usageStatsSwitched).toHaveBeenLastCalledWith(true, 7);
    await act(async () => toggle.click());
    expect(setErrorReportConsent).toHaveBeenLastCalledWith(false);
    expect(request).toHaveBeenCalledWith("/api/analytics", { method: "PUT", body: '{"enabled":false}' });
    expect(usageStatsSwitched).toHaveBeenLastCalledWith(false, 7);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each(["en", "ko"] as const)("turns off both consents after first-run usage opt-in with one switch in %s", async (locale) => {
  persistPreference(locale);
  let usage = true;
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.body) usage = JSON.parse(String(init.body)).enabled;
    return { enabled: usage };
  });
  const setErrorReportConsent = vi.fn(async (value: boolean) => value);
  Object.defineProperty(window, "ogb", { value: { errorReportConsent: async () => false, setErrorReportConsent }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(1);
    const toggle = host.querySelector("button")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe(locale === "en" ? "Crash reports and stats" : "오류 보고와 통계");
    expect(setErrorReportConsent).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => toggle.click());
    expect(usage).toBe(false);
    expect(setErrorReportConsent).toHaveBeenCalledExactlyOnceWith(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally { await act(async () => root.unmount()); }
});

it("keeps the switch on after a partial save so opt-out can be retried", async () => {
  let reports = true;
  let usage = true;
  let fail = true;
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.body) {
      if (fail) throw new Error("offline");
      usage = JSON.parse(String(init.body)).enabled;
    }
    return { enabled: usage };
  });
  Object.defineProperty(window, "ogb", { value: { errorReportConsent: async () => reports,
    setErrorReportConsent: async (value: boolean) => { reports = value; return value; } }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    const toggle = host.querySelector("button")!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fail = false;
    await act(async () => toggle.click());
    expect(reports).toBe(false);
    expect(usage).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally { await act(async () => root.unmount()); }
});

it("allows opt-out after an initial analytics read failure when native consent is on", async () => {
  const reports = true;
  request.mockRejectedValueOnce(new Error("offline"));
  const setErrorReportConsent = vi.fn(async (value: boolean) => value);
  Object.defineProperty(window, "ogb", { value: { errorReportConsent: async () => reports, setErrorReportConsent }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    const toggle = host.querySelector("button")!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe(String(reports));
    await act(async () => toggle.click());
    expect(setErrorReportConsent).toHaveBeenCalledExactlyOnceWith(!reports);
    expect(request).toHaveBeenCalledWith("/api/analytics", { method: "PUT", body: JSON.stringify({ enabled: !reports }) });
    expect(toggle.getAttribute("aria-checked")).toBe(String(!reports));
  } finally { await act(async () => root.unmount()); }
});

it.each(["reports", "usage"])("retries unknown %s consent without enabling reports", async (unknown) => {
  vi.useFakeTimers();
  const errorReportConsent = vi.fn().mockResolvedValue(false);
  if (unknown === "reports") errorReportConsent.mockRejectedValueOnce(new Error("offline"));
  else request.mockRejectedValueOnce(new Error("offline"));
  const setErrorReportConsent = vi.fn(async (value: boolean) => value);
  Object.defineProperty(window, "ogb", { value: { errorReportConsent, setErrorReportConsent }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    const toggle = host.querySelector("button")!;
    expect(toggle.disabled).toBe(true);
    await act(async () => toggle.click());
    expect(setErrorReportConsent).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([, init]) => !init)).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(setErrorReportConsent).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it.each(["reports", "usage"].flatMap((unknown) => [false, true].map((enabled) => ({ unknown, enabled }))))("recovers unknown $unknown consent after partial opt-out to $enabled", async ({ unknown, enabled }) => {
  vi.useFakeTimers();
  let offline = true;
  let reports = unknown === "usage";
  let usage = unknown === "reports";
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (offline && unknown === "usage") throw new Error("offline");
    if (init?.body) usage = JSON.parse(String(init.body)).enabled;
    return { enabled: usage };
  });
  const setErrorReportConsent = vi.fn(async (value: boolean) => {
    if (offline && unknown === "reports") throw new Error("offline");
    reports = value;
    return value;
  });
  Object.defineProperty(window, "ogb", { value: {
    errorReportConsent: async () => {
      if (offline && unknown === "reports") throw new Error("offline");
      return reports;
    }, setErrorReportConsent,
  }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    const toggle = host.querySelector("button")!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    if (unknown === "reports") reports = enabled;
    else usage = enabled;
    offline = false;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe(String(enabled));
    expect(setErrorReportConsent).toHaveBeenCalledExactlyOnceWith(false);
    expect(request.mock.calls.filter(([, init]) => init?.body)).toHaveLength(1);
    if (enabled) {
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(reports).toBe(false);
      expect(usage).toBe(false);
    }
  } finally { await act(async () => root.unmount()); }
});

it.each(["reports", "usage"])("preserves enabled %s consent while its opt-out and recovery read fail", async (failed) => {
  let reports = true;
  let usage = true;
  let offline = false;
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (offline && failed === "usage") throw new Error("offline");
    if (init?.body) usage = JSON.parse(String(init.body)).enabled;
    return { enabled: usage };
  });
  const setErrorReportConsent = vi.fn(async (value: boolean) => {
    if (offline && failed === "reports") throw new Error("offline");
    reports = value;
    return value;
  });
  Object.defineProperty(window, "ogb", { value: {
    errorReportConsent: async () => {
      if (offline && failed === "reports") throw new Error("offline");
      return reports;
    }, setErrorReportConsent,
  }, configurable: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ErrorReportsRow))));
    const toggle = host.querySelector("button")!;
    offline = true;
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(false);
    offline = false;
    await act(async () => toggle.click());
    expect(setErrorReportConsent.mock.calls.map(([value]) => value)).toEqual([false, false]);
    expect(request.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init!.body)).enabled)).toEqual([false, false]);
    expect(reports).toBe(false);
    expect(usage).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally { await act(async () => root.unmount()); }
});
