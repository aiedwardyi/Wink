// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { ErrorReportsRow } from "./ErrorReportsRow";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", () => ({ api: request }));
beforeEach(() => request.mockReset().mockResolvedValue({ enabled: false }));
afterEach(() => { delete window.ogb; localStorage.setItem("omb-locale", "en"); });

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
    expect(host.textContent).toContain("Anonymous crash reports and usage counts. No chats or files. Turn off anytime.");
    await act(async () => toggle.click());
    expect(setErrorReportConsent).toHaveBeenLastCalledWith(true);
    expect(request).toHaveBeenCalledWith("/api/analytics", { method: "PUT", body: '{"enabled":true}' });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(setErrorReportConsent).toHaveBeenLastCalledWith(false);
    expect(request).toHaveBeenCalledWith("/api/analytics", { method: "PUT", body: '{"enabled":false}' });
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
    expect(toggle.getAttribute("aria-label")).toBe(locale === "en" ? "Error reports and usage stats" : "오류 보고 및 사용 통계");
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

it.each([true, false])("uses native consent %s after an initial analytics read failure", async (reports) => {
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
