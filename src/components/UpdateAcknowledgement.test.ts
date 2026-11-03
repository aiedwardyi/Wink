// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/updater";

import { UpdateButton } from "./Sidebar";
import { UpdatesRow } from "./SettingsModal";

applyLocale("en");

/** A check whose result lands after the acknowledgement window would have
 * expired if it were timed from the click. */
const SLOW_CHECK_MS = 5000;

function installUpdater(status: UpdaterState["status"] = "idle") {
  const listeners = new Set<(s: UpdaterState) => void>();
  const emit = (s: UpdaterState) => listeners.forEach((cb) => cb(s));
  const updater = {
    check: () =>
      new Promise<void>((resolve) => {
        emit({ status: "checking" });
        setTimeout(() => {
          emit({ status: "idle" });
          resolve();
        }, SLOW_CHECK_MS);
      }),
    download: () => Promise.resolve(),
    install: () => Promise.resolve(),
    onState: (cb: (s: UpdaterState) => void) => {
      listeners.add(cb);
      cb({ status, version: "1.0.227" });
      return () => listeners.delete(cb);
    },
  };
  Object.defineProperty(window, "ogb", { value: { updater }, configurable: true, writable: true });
}

async function clickAndSettle(host: HTMLElement) {
  const button = host.querySelector("button")!;
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SLOW_CHECK_MS);
  });
}

describe("manual update check acknowledgement", () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    installUpdater();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it.each(["idle", "checking"] as const)("hides the sidebar button while %s", async (status) => {
    installUpdater(status);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdateButton)));
    });
    expect(host.querySelector("button")).toBeNull();
  });

  it("shows the sidebar download button for an available update", async () => {
    installUpdater("available");
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdateButton)));
    });
    expect(host.querySelector("button")!.getAttribute("aria-label")).toContain("1.0.227");
    expect(host.querySelector(".lucide-arrow-down-to-line")).not.toBeNull();
  });

  it("acknowledges a slow check in the Settings updates row", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(UpdatesRow)));
    });
    expect(host.textContent).toContain("Up to date.");
    await clickAndSettle(host);
    expect(host.textContent).toContain("You're up to date");
  });
});
