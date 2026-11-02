// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { DiagnosticsRow } from "./SettingsModal";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  delete window.ogb;
  vi.unstubAllGlobals();
});

async function mount(exportDiagnostics: () => Promise<string | null>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  applyLocale("en");
  Object.assign(window, { ogb: { exportDiagnostics } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(DiagnosticsRow))));
  return host.querySelector<HTMLButtonElement>("button")!;
}

it("renders the diagnostics control and reports the saved file", async () => {
  const exportDiagnostics = vi.fn(async () => "C:\\reports\\wink-diagnostics.txt");
  const button = await mount(exportDiagnostics);
  expect(button.getAttribute("aria-label")).toBe("Export Diagnostics to a Text File");
  await act(async () => button.click());
  expect(exportDiagnostics).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("C:\\reports\\wink-diagnostics.txt");
  expect(button.disabled).toBe(false);
});

it("leaves a cancelled export quiet", async () => {
  const button = await mount(async () => null);
  await act(async () => button.click());
  expect(host.querySelector('[role="status"], [role="alert"]')).toBeNull();
  expect(button.disabled).toBe(false);
});

it("shows export errors and permits a retry", async () => {
  const button = await mount(async () => { throw new Error("Save failed"); });
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
  expect(button.disabled).toBe(false);
});
