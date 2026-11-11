// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider, translate, type LocaleId } from "@/lib/i18n";
import type { UsageWaitView } from "../../server/limit-wait-store";
import { ErrorRow } from "./ChatView";
import { usageLimitReset } from "@/lib/usage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
const resumesAt = Date.parse("2026-10-30T03:40:00Z");
const base: UsageWaitView = { id: "wait", ownerDeviceId: "pc-a", state: "waiting", resumesAt, weekly: false, cancelable: true };

it("L6: the Korean weekly line says the limit is still reached", () => {
  expect(translate("ko", "chat.usageWaitWeekly", { time: "금 3:40" })).toContain("아직");
});

async function mount(locale: LocaleId, view?: UsageWaitView, onRetry?: () => void, model?: boolean) {
  localStorage.setItem("omb-locale", locale);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const reset = Date.now() + 60 * 60_000;
  const render = async (usageWait?: UsageWaitView) => act(async () => root.render(createElement(I18nProvider, null,
    createElement(ErrorRow, { botId: "bot", message: "Provider detail", usageLimit: { resetsAt: reset, model }, usageWait, onRetry }))));
  await render(view);
  return { host, render, reset, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const actions = (host: HTMLElement) => host.querySelectorAll<HTMLButtonElement>("button:not([data-all-usage])");

it.each(["en", "ko"] as const)("renders every usage wait line in %s without duplicate rows", async (locale) => {
  const view = await mount(locale, base);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(resumesAt);
  try {
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitAt", { time }));
    expect(actions(view.host)).toHaveLength(1);
    expect(actions(view.host)[0].textContent).toBe(translate(locale, "chat.cancelQueuedAction"));
    await view.render({ ...base, resumesAt: null });
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitUnknown"));
    expect(view.host.textContent).not.toContain(translate(locale, "chat.usageWaitAt", { time }));
    const weeklyTime = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", weekday: "short" }).format(resumesAt);
    await view.render({ ...base, weekly: true });
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitWeekly", { time: weeklyTime }));
    expect(actions(view.host)).toHaveLength(1);
    await view.render({ ...base, state: "manual" });
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitManual"));
    expect(actions(view.host)).toHaveLength(0);
    expect(view.host.querySelector("[data-engine-details]")).toBeNull();
    expect(view.host.querySelector("[data-engine-details-body]")?.textContent).toBe("Provider detail");
    expect(view.host.textContent?.match(/Provider detail/g)).toHaveLength(1);
  } finally { await view.close(); }
});

it.each(["en", "ko"] as const)("M1: only a live manual wait asks for Continue in %s", async (locale) => {
  const view = await mount(locale, { ...base, state: "manual" });
  try {
    expect(view.host.textContent).toContain(translate(locale, "chat.usageWaitManual"));
    for (const state of ["dispatching", "finished"] as const) {
      await view.render({ ...base, state });
      expect(view.host.textContent).not.toContain(translate(locale, "chat.usageWaitManual"));
      expect(view.host.textContent).not.toContain("Resumes at");
      expect(actions(view.host)).toHaveLength(0);
    }
  } finally { await view.close(); }
});

it.each(["en", "ko"] as const)("M5: untracked and ACP limits retain their reset and Retry in %s", async (locale) => {
  const retry = vi.fn(); const view = await mount(locale, undefined, retry);
  try {
    const reset = usageLimitReset(view.reset)!;
    expect(view.host.textContent).toContain(translate(locale, "chat.usageLimitBody"));
    expect(view.host.textContent).toContain(translate(locale, reset.key, reset.vars));
    expect(view.host.textContent).not.toContain(translate(locale, "chat.usageWaitManual"));
    await act(async () => view.host.querySelector<HTMLButtonElement>("button")!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  } finally { await view.close(); }
});

it.each([["en", false], ["en", true], ["ko", false], ["ko", true]] as const)("a per-model cap gets its own body in %s (model %s)", async (locale, model) => {
  const view = await mount(locale, undefined, undefined, model);
  try {
    const [shown, hidden] = model ? ["chat.usageLimitModelBody", "chat.usageLimitBody"] as const : ["chat.usageLimitBody", "chat.usageLimitModelBody"] as const;
    expect(view.host.textContent).toContain(translate(locale, shown));
    expect(view.host.textContent).not.toContain(translate(locale, hidden));
  } finally { await view.close(); }
});

it("Cancel calls the scoped route and a foreign owner's projection stays read-only", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const view = await mount("en", base);
  try {
    expect(actions(view.host)).toHaveLength(1);
    await act(async () => actions(view.host)[0].click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/bots/bot/usage-wait/wait/cancel", expect.objectContaining({ method: "POST" }));
    await view.render({ ...base, cancelable: false });
    expect(view.host.textContent).toContain("Resumes at");
    expect(view.host.textContent).not.toContain(translate("en", "chat.cancelQueuedAction"));
    expect(actions(view.host)).toHaveLength(0);
  } finally { await view.close(); }
});

it("fades the wait card in as it arrives", async () => {
  const view = await mount("en", base);
  try {
    expect(view.host.querySelector("[data-usage-wait]")!.parentElement!.classList.contains("animate-fade-in")).toBe(true);
  } finally { await view.close(); }
});
