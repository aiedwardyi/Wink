// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { trackOnboard } from "@/lib/usage-stats";
import { OnboardingFinish } from "./OnboardingFinish";

vi.mock("@/lib/usage-stats", async (original) => ({ ...(await original<typeof import("@/lib/usage-stats")>()), trackOnboard: vi.fn() }));

it.each([[false, true], [true, false]])("passes the first-run sharing choice on Open (unticked %s)", async (untick, enabled) => {
  const done = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(OnboardingFinish, { onDone: done }))));
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    expect(host.textContent).toContain("Speed, crashes, features. Never chats, files or names.");
    expect(done).not.toHaveBeenCalled();
    if (untick) await act(async () => box.click());
    await act(async () => host.querySelector("button")!.click());
    expect(trackOnboard).toHaveBeenCalledWith("finish");
    expect(done).toHaveBeenCalledExactlyOnceWith(enabled);
  } finally {
    await act(async () => root.unmount());
  }
});
