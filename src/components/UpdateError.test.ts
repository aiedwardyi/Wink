// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLocale, I18nProvider, persistPreference } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/updater";

import { UpdateBanner } from "./UpdateBanner";
import { UpdatesRow } from "./SettingsModal";

const RAW_504 = `504 "method: GET url: https://github.com/x/releases/download/v1/latest.yml\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n" Data: <html>504 Gateway Time-out</html>\nHeaders: { "server": "GitHub.com" }`;

function installUpdater(state: UpdaterState) {
  const updater = {
    check: () => Promise.resolve(),
    download: () => Promise.resolve(),
    install: () => Promise.resolve(),
    onState: (cb: (s: UpdaterState) => void) => {
      cb(state);
      return () => {};
    },
  };
  Object.defineProperty(window, "ogb", { value: { updater }, configurable: true, writable: true });
}

describe("update failures read plain", () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    applyLocale("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    persistPreference("en");
    act(() => root.unmount());
    host.remove();
  });

  async function render(component: typeof UpdatesRow | typeof UpdateBanner, state: UpdaterState) {
    installUpdater(state);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(component)));
    });
    return host.textContent ?? "";
  }

  it("Settings shows the transient line for a 504 body, never the raw text", async () => {
    const text = await render(UpdatesRow, { status: "error", message: RAW_504 });
    expect(text).toContain("Couldn't reach the update server. Try again in a few minutes.");
    expect(text).not.toMatch(/http|Headers|\d{3}/i);
  });

  it("Settings shows the generic line for other errors", async () => {
    const text = await render(UpdatesRow, { status: "error", message: "sha512 checksum mismatch" });
    expect(text).toContain("Couldn't check for updates.");
    expect(text).not.toContain("sha512");
  });

  it("Settings keeps the unavailable line for a missing update config", async () => {
    const text = await render(UpdatesRow, { status: "error", message: "ENOENT app-update.yml" });
    expect(text).toContain("Updates aren't available in this build");
  });

  it("the toast subtitle is the same plain line, not a bare code", async () => {
    const text = await render(UpdateBanner, { status: "error", message: RAW_504 });
    expect(text).toContain("Couldn't reach the update server. Try again in a few minutes.");
    expect(text).not.toMatch(/504|http|Headers/);
  });

  it("Korean has the transient and generic lines", async () => {
    persistPreference("ko");
    const transient = await render(UpdatesRow, { status: "error", message: RAW_504 });
    expect(transient).toMatch(/[가-힣]/);
    expect(transient).not.toMatch(/http|Headers|\d{3}/i);
    const other = await render(UpdatesRow, { status: "error", message: "sha512 checksum mismatch" });
    expect(other).toMatch(/[가-힣]/);
  });
});
