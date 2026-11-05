import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyLocale, t } from "@/lib/i18n";
import type { RateLimitWindow } from "../../server/contracts.ts";

import { ChatPlanMeters, lineFacts } from "./ChatPlanMeters";

const now = Date.UTC(2026, 8, 4, 12, 0, 0);

function render(windows: RateLimitWindow[] | undefined) {
  applyLocale("en");
  return renderToStaticMarkup(createElement(ChatPlanMeters, { windows, now, onOpenUsage: () => {} }));
}

function line(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  const text = (hook: string) => host.querySelector(`[data-usage-meter] [${hook}]`)?.textContent ?? null;
  return { first: text("data-meter-first"), second: text("data-meter-second") };
}

describe("ChatPlanMeters", () => {
  it.each(["en", "ko"] as const)("distinguishes weekly-only coverage from a missing report (%s)", (locale) => {
    applyLocale(locale);
    const windows = [{ id: "seven_day", kind: "week" as const, usedPercent: 71, resetsAt: now + 53 * 3_600_000, windowMinutes: 10080 }];
    expect(lineFacts(windows, "complete", t).second).toBe(locale === "en" ? "Weekly only" : "주간만");
    expect(lineFacts(windows, "unknown", t).second).toBe(locale === "en" ? "5h No data" : "5시간 데이터 없음");
  });

  it("hides when the engine has no live plan windows", () => {
    expect(render(undefined)).toBe("");
    expect(render([])).toBe("");
    expect(
      render([{ id: "five_hour", usedPercent: 40, resetsAt: now - 60_000 }]),
    ).toBe("");
  });

  it("shows the live 5-hour and weekly windows with remaining percent, the binding one first", () => {
    const html = render([
      { id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 },
      { id: "seven_day", usedPercent: 49, resetsAt: now + 53 * 3_600_000 },
      { id: "seven_day_opus", usedPercent: 75, resetsAt: now + 53 * 3_600_000 },
      { id: "stale", usedPercent: 40, resetsAt: now - 60_000 },
    ]);
    expect(line(html)).toEqual({ first: "7d 51%", second: "5h 90%" });
    expect(html).not.toContain("25%");
    expect(html).not.toContain("60%");
    expect(html).not.toContain("10%");
    expect(html).not.toContain("% remaining");
    expect(html).not.toContain("$");
    expect(html).not.toContain("Fixed");
    expect(html).not.toContain("on-demand");
    expect(line(render([
      { id: "seven_day", usedPercent: 49, resetsAt: now + 53 * 3_600_000 },
      { id: "five_hour", usedPercent: 80, resetsAt: now + 115 * 60_000 },
    ]))).toEqual({ first: "5h 20%", second: "7d 51%" });
  });

  it("reads both wire windows as percent left without inventing an unknown value", () => {
    const html = render([
      { id: "primary", usedPercent: 80, windowMinutes: 300, resetsAt: now + 106 * 60_000 },
      { id: "secondary", usedPercent: 125, windowMinutes: 10080, resetsAt: now + 86_400_000 },
    ]);
    expect(line(html)).toEqual({ first: "7d 0%", second: "5h 20%" });
    const unknown = render([{ id: "five_hour", usedPercent: NaN, resetsAt: now + 60_000 }]);
    expect(unknown).not.toContain("100%");
    expect(unknown).not.toContain("NaN");
    expect(render([{ id: "five_hour", usedPercent: 80, resetsAt: now - 1 }])).toBe("");
  });

  it("keeps a weekly-only report and says the session window has no data", () => {
    expect(line(render([{ id: "seven_day", usedPercent: 71, resetsAt: now + 53 * 3_600_000 }]))).toEqual({ first: "7d 29%", second: "5h No data" });
  });

  it("never renders a token readout", () => {
    const live: RateLimitWindow[] = [{ id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 }];
    const html = render(live);
    expect(html).not.toContain("↑");
    expect(html).not.toContain("↓");
    expect(line(html)).toEqual({ first: "5h 90%", second: null });
  });

  it("dispatches the usage action when the strip is clicked", async () => {
    applyLocale("en");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onOpenUsage = vi.fn();
    try {
      await act(async () => {
        root.render(createElement(ChatPlanMeters, {
          windows: [{ id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 }],
          now,
          onOpenUsage,
        }));
      });
      const button = host.querySelector("button");
      expect(button).not.toBeNull();
      await act(async () => button?.click());
      expect(onOpenUsage).toHaveBeenCalledOnce();
    } finally {
      root.unmount();
      host.remove();
    }
  });

  // Guards the phone remote view: same wiring ChatView uses
  // (onOpenUsage -> dispatch toggleAppSettings/usage), exercised at a phone
  // viewport width so a narrow layout regression would fail this test.
  it("dispatches toggleAppSettings for usage when tapped at a phone viewport width", async () => {
    applyLocale("en");
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const dispatch = vi.fn();
    const onOpenUsage = () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" });
    try {
      await act(async () => {
        root.render(createElement(ChatPlanMeters, {
          windows: [{ id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 }],
          now,
          onOpenUsage,
        }));
      });
      const button = host.querySelector("button");
      expect(button).not.toBeNull();
      expect(button?.className).toContain("w-full");
      await act(async () => button?.click());
      expect(dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "usage" });
    } finally {
      root.unmount();
      host.remove();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("mutes an old Muse reading and says when it was last seen", () => {
    applyLocale("en");
    const windows = [
      { id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 },
      { id: "seven_day", usedPercent: 100, resetsAt: now + 35 * 3_600_000 },
    ];
    const host = document.createElement("div");
    const draw = (driverKind: string, ageMs: number) => {
      host.innerHTML = renderToStaticMarkup(createElement(ChatPlanMeters, {
        windows, driverKind, observedAt: new Date(now - ageMs).toISOString(), now, onOpenUsage: () => {},
      }));
      return host.querySelector("[data-usage-meter]")!;
    };
    const stale = draw("museAgent", 4 * 86_400_000);
    expect(host.textContent).toContain("Last seen 4d ago");
    expect(stale.className).toContain("opacity-70");
    expect(stale.querySelector("[data-meter-first]")?.textContent).toBe("7d 0%");
    const fresh = draw("museAgent", 30 * 60_000);
    expect(host.textContent).not.toContain("Last seen");
    expect(fresh.className).not.toContain("opacity-70");
    expect(fresh.querySelector("[data-meter-first]")?.className).toContain("text-danger");
    const other = draw("claudeAgent", 4 * 86_400_000);
    expect(host.textContent).not.toContain("Last seen");
    expect(other.className).not.toContain("opacity-70");
    expect(other.querySelector("[data-meter-first]")?.className).toContain("text-danger");
  });

  it("describes the strip with a stale Muse reading's age and keeps its name", () => {
    applyLocale("en");
    const windows = [{ id: "five_hour", usedPercent: 10, resetsAt: now + 115 * 60_000 }];
    const host = document.createElement("div");
    const draw = (ageMs: number) => {
      host.innerHTML = renderToStaticMarkup(createElement(ChatPlanMeters, {
        windows, driverKind: "museAgent", observedAt: new Date(now - ageMs).toISOString(), now, onOpenUsage: () => {},
      }));
      return host.querySelector("button");
    };
    const stale = draw(4 * 86_400_000);
    const describedBy = stale?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(host.querySelector(`[id="${describedBy}"]`)?.textContent).toBe("Last seen 4d ago");
    expect(stale?.getAttribute("aria-label")).toBe("Open Usage Settings");
    const fresh = draw(30 * 60_000);
    expect(fresh?.hasAttribute("aria-describedby")).toBe(false);
    expect(fresh?.getAttribute("aria-label")).toBe("Open Usage Settings");
  });
});
