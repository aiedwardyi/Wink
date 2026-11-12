// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { trackOnboard, usageStatsSwitched } from "@/lib/usage-stats";
import { OnboardingFinish } from "./OnboardingFinish";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", () => ({ api: request }));
vi.mock("@/lib/usage-stats", async (original) => ({ ...(await original<typeof import("@/lib/usage-stats")>()), trackOnboard: vi.fn(), usageStatsSwitched: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async (_path: string, init?: RequestInit) => {
    const { enabled } = JSON.parse(String(init?.body)) as { enabled: boolean };
    return { enabled, capture: enabled, period: 7 };
  });
});

it.each([[false, true], [true, false]])("saves the first-run box and tells this screen's stats (unticked %s)", async (untick, enabled) => {
  const done = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(I18nProvider, null, createElement(OnboardingFinish, { onDone: done }))));
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    expect(host.textContent).toContain("Speed, crashes, features. Never chats, files or names.");
    expect(request).not.toHaveBeenCalled();
    if (untick) await act(async () => box.click());
    await act(async () => host.querySelector("button")!.click());
    expect(trackOnboard).toHaveBeenCalledWith("finish");
    expect(request).toHaveBeenCalledWith("/api/analytics", { method: "PUT", body: JSON.stringify({ enabled }) });
    // Unticked stops this screen before the PC answers.
    expect(vi.mocked(usageStatsSwitched).mock.calls).toEqual(untick ? [[false], [false, 7]] : [[true, 7]]);
    if (untick) expect(vi.mocked(usageStatsSwitched).mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]!);
    expect(done).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
