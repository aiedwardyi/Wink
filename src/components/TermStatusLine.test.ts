import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { PHONE_QUERY } from "@/lib/phone-swipe";
import { StoreProvider, useStore, type Bot, type InstanceInfo, type Message } from "@/state/store";

import { TermStatusLine } from "./TermStatusLine";

const now = Date.UTC(2026, 9, 11, 8, 30);
const bot: Bot = {
  id: "a", threadId: "thread-a", name: "A", cwd: "/default",
  title: "", description: "", color: "blue", notifications: false, unread: false,
  modelSelection: { instanceId: "current", model: "old-model", effort: "low" },
  messages: [],
};
const engine: InstanceInfo = {
  instanceId: "current", driverKind: "claudeAgent", displayName: "Current",
  snapshot: { state: "available" },
  models: { default: "old-model", options: [{ id: "old-model", label: "Old model" }] },
  rateLimits: {
    observedAt: new Date(now - 60_000).toISOString(),
    windows: [{ id: "five_hour", usedPercent: 71, resetsAt: now + 60_000 }],
  },
};
const summary = (id: string, at: number, parentId?: string): Message => ({
  id, at, parentId, role: "bot", kind: "compaction",
  compaction: {
    v: 1, summary: "Fixture summary.", coveredThroughId: "prompt", firstKeptId: null,
    contextWindow: 200000, estimatedTokensBefore: 150000, sourceMessageCount: 40,
  },
});

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.skin;
  applyLocale("en");
});

async function render(current = bot, instance = engine, cwd?: string | null, instances = [instance], locale: "en" | "ko" = "en") {
  applyLocale(locale);
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class {
    close() {}
  });
  let store: ReturnType<typeof useStore>;
  function Harness() {
    store = useStore();
    return createElement(TermStatusLine, { bot: current, engine: instance, cwd });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Harness))));
  await act(async () => store.dispatch({ type: "instances", instances }));
  return Object.assign(host, { store: () => store });
}

function shown(button: Element) {
  const copy = button.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return copy.textContent!.replace(/\s+/g, " ").trim();
}

const described = (host: Element, button: Element) =>
  (button.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => host.querySelector(`[id="${id}"]`));

function phoneMedia(matches = true) {
  const media = window.matchMedia(`${PHONE_QUERY} and (pointer: coarse)`);
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  vi.spyOn(media, "matches", "get").mockReturnValue(matches);
  return media;
}

describe("TermStatusLine", () => {
  it.each(["terminal", "terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal"])("fits the phone cut for %s in both locales", async (skin) => {
    phoneMedia();
    document.documentElement.dataset.skin = skin;
    for (const locale of ["en", "ko"] as const) {
      const current = { ...bot, name: "Pokkey Film Production Assistant", messages: [summary("saved", now - 3600_000)] };
      const instance = {
        ...engine,
        models: { default: "old-model", options: [{ id: "old-model", label: "Claude Sonnet 4.6 (Thinking)" }] },
        rateLimits: { observedAt: new Date(now - 60_000).toISOString(), windows: [
          { id: "five_hour", usedPercent: 10, resetsAt: now + 60_000 },
          { id: "seven_day", usedPercent: 71, resetsAt: now + (5 * 24 + 6) * 3600_000 },
        ] },
      };
      const host = await render(current, instance, undefined, [instance], locale);
      const status = host.querySelector("[data-term-status]")!;
      expect(status.getAttribute("data-term-phone")).toBe(skin);
      expect(status.querySelector("[data-term-model]")?.textContent).toBe(skin === "multiplexer" ? "Sonnet 4.6" : "◆ Sonnet 4.6");
      expect(status.textContent).not.toMatch(/Claude|Thinking|\/default|low|9999|summary|요약/);
      const button = status.querySelector<HTMLButtonElement>("[data-term-ticker]")!;
      const weekly = locale === "en" ? "7d 29% ↻ 5d 6h" : "7일 29% ↻ 5일 6시간";
      const session = locale === "en" ? "5h 90%" : "5시간 90%";
      expect(shown(button)).toBe(skin === "multiplexer" ? weekly : `${weekly} │ ${session}`);
      expect(status.querySelector("[data-term-meters]")?.getAttribute("data-term-meters")).toBe(skin === "multiplexer" ? "1" : "2");
      expect(described(host, button)[0]?.textContent).toContain(locale === "en" ? "7d 29%" : "7일 29%");
      expect(status.querySelector("[data-term-bar]")).toBeNull();
      const tab = status.querySelector("[data-term-tab]");
      expect(tab?.textContent ?? null).toBe(skin === "multiplexer" ? `0:${current.name}*` : null);
      await act(async () => button.click());
      expect(host.store().state.appSettingsOpen).toBe(true);
      expect(host.store().state.appSettingsSection).toBe("usage");
      await unmount?.();
      unmount = null;
    }
  });

  it.each([
    ["remaining", 80, 20, "5h", "↻ 1h 0m", 20],
    ["remaining", 20, 80, "7d", "↻ 5d 6h", 20],
    ["remaining", 80, 80, "5h", "↻ 1h 0m", 20],
    ["remaining", 100, 120, "5h", "↻ 1h 0m", 0],
  ] as const)("selects the tighter window in %s mode (%i session / %i weekly used -> %s)", async (_mode, session, weekly, label, reset, percent) => {
    phoneMedia();
    document.documentElement.dataset.skin = "multiplexer";
    const host = await render(bot, {
      ...engine,
      rateLimits: { ...engine.rateLimits!, windows: [
        { id: "seven_day", usedPercent: weekly, resetsAt: now + (5 * 24 + 6) * 3600_000 },
        { id: "five_hour", usedPercent: session, resetsAt: now + 3600_000 },
      ] },
    });
    const button = host.querySelector<HTMLButtonElement>("[data-term-ticker]")!;
    expect(shown(button)).toBe(`${label} ${percent}% ${reset}`);
    expect(button.textContent).not.toContain(label === "5h" ? "7d" : "5h");
  });

  it.each(["multiplexer", "modal"])("keeps a weekly-only report in %s", async (skin) => {
    phoneMedia();
    document.documentElement.dataset.skin = skin;
    const host = await render(bot, {
      ...engine,
      rateLimits: { ...engine.rateLimits!, windows: [{ id: "seven_day", usedPercent: 71, resetsAt: now + (5 * 24 + 6) * 3600_000 }] },
    });
    const button = host.querySelector<HTMLButtonElement>("[data-term-ticker]")!;
    expect(shown(button)).toMatch(/^7d 29% ↻ 5d 6h/);
    expect(button.textContent).not.toContain("5h");
  });

  it("falls back to the session meter when there is no weekly window", async () => {
    phoneMedia();
    const host = await render();
    expect(shown(host.querySelector("[data-term-phone] [data-term-ticker]")!)).toBe("5h 29% ↻ 1:00");
  });

  it("keeps a stale phone reading accessible when the visual age is omitted", async () => {
    phoneMedia();
    const host = await render(bot, { ...engine, driverKind: "museAgent", rateLimits: { ...engine.rateLimits!, observedAt: new Date(now - 4 * 86400_000).toISOString() } });
    const button = host.querySelector<HTMLButtonElement>("[data-term-ticker]")!;
    const age = described(host, button).find((node) => node?.textContent === "Last seen 4d ago")!;
    expect(age).toBeTruthy();
    expect(age.className).toBe("sr-only");
    expect(shown(button)).not.toContain("Last seen");
    expect(button.className).toContain("text-ink-secondary");
  });

  it.each([false, true])("keeps desktop markup when the phone query is %s and restores it on resize", async (matches) => {
    const media = phoneMedia(matches);
    const host = await render();
    if (matches) {
      expect(host.querySelector("[data-term-phone]")).not.toBeNull();
      vi.spyOn(media, "matches", "get").mockReturnValue(false);
      await act(async () => media.dispatchEvent(new Event("change")));
    }
    expect(host.querySelector("[data-term-phone]")).toBeNull();
    expect(host.textContent).toContain("Old model");
    expect(host.textContent).toContain("/default");
    expect(host.textContent).not.toMatch(/summary|turns kept|요약|보관된 턴/);
    const ticker = host.querySelector("[data-term-status] [data-term-ticker]")!;
    expect(shown(ticker)).toBe("5h 29% ↻ 1:00");
    expect(ticker.querySelector("[data-glyphs]")).toBeNull();
  });

  it("mutes and describes a stale Muse reading with its age", async () => {
    const host = await render(bot, { ...engine, driverKind: "museAgent", rateLimits: { ...engine.rateLimits!, observedAt: new Date(now - 4 * 86400_000).toISOString() } });
    const button = host.querySelector<HTMLButtonElement>("[data-term-ticker]")!;
    expect(shown(button)).toMatch(/^Last seen 4d ago · 5h 29%/);
    expect(button.className).toContain("text-ink-secondary");
    expect(described(host, button).map((node) => node?.textContent)).toContain("Last seen 4d ago");
    expect(button.getAttribute("aria-label")).toBe("Open Usage Settings");
  });

  it("discloses a fresh Muse reading without muting it", async () => {
    const host = await render(bot, { ...engine, driverKind: "museAgent" });
    expect(host.textContent).toContain("As of 1m ago");
    expect(host.querySelector("button")?.className).not.toContain("text-ink-secondary");
  });

  it("labels the pending model with its matching instance and effort", async () => {
    const next = { ...engine, instanceId: "next", models: { default: "next-model", options: [{ id: "next-model", label: "Next model" }] } };
    const host = await render({ ...bot, pendingModelSelection: { instanceId: "next", model: "next-model", effort: "high" } }, engine, undefined, [engine, next]);
    expect(host.textContent).toContain("Next model");
    expect(host.textContent).toContain("high");
    expect(host.textContent).not.toContain("Old model");
    expect(host.textContent).not.toContain("low");
  });

  it("hides bars when a busy bot's pending pick reports no windows", async () => {
    const gemini: InstanceInfo = {
      ...engine,
      instanceId: "gemini",
      driverKind: "geminiAgent",
      rateLimits: undefined,
      models: { default: "gemini-flash", options: [{ id: "gemini-flash", label: "Gemini 3.8 Flash" }] },
    };
    const host = await render(
      { ...bot, busy: true, pendingModelSelection: { instanceId: "gemini", model: "gemini-flash", effort: "high" } },
      engine,
      undefined,
      [engine, gemini],
    );
    expect(host.querySelector("[data-term-status] button")).toBeNull();
    expect(host.textContent).not.toContain("5h");
    expect(host.textContent).not.toContain("29%");
  });

  it("shows the pending instance's windows and reading", async () => {
    const muse: InstanceInfo = {
      ...engine,
      instanceId: "muse",
      driverKind: "museAgent",
      models: { default: "muse-model", options: [{ id: "muse-model", label: "Muse model" }] },
      rateLimits: {
        observedAt: new Date(now - 4 * 86400_000).toISOString(),
        windows: [
          { id: "five_hour", usedPercent: 10, resetsAt: now + 3_600_000 },
          { id: "seven_day", usedPercent: 40, resetsAt: now + 86_400_000 },
        ],
      },
    };
    const host = await render(
      { ...bot, busy: true, pendingModelSelection: { instanceId: "muse", model: "muse-model", effort: "high" } },
      engine,
      undefined,
      [engine, muse],
    );
    const status = host.querySelector("[data-term-status]")!;
    expect(status.textContent).toContain("Last seen 4d ago");
    expect(status.textContent).toContain("90%");
    expect(status.textContent).toContain("60%");
    expect(status.textContent).not.toContain("29%");
  });

  it("shows the running engine's bars when nothing is pending", async () => {
    const host = await render({ ...bot, busy: true });
    const status = host.querySelector("[data-term-status]")!;
    expect(status.textContent).toContain("5h");
    expect(status.textContent).toContain("29%");
    expect(status.textContent).not.toContain("Last seen");
  });

  it.each(["/pinned", null])("uses the task's %s folder instead of the bot default", async (cwd) => {
    const host = await render(bot, engine, cwd);
    expect(host.textContent).not.toContain("/default");
    if (cwd) expect(host.textContent).toContain(cwd);
  });

  it.each(["terminal", "terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal"])("omits summary and turn status in %s for both locales", async (skin) => {
    document.documentElement.dataset.skin = skin;
    for (const locale of ["en", "ko"] as const) {
      for (const messages of [[], [summary("saved", now - 2 * 3600_000)]]) {
        const host = await render({ ...bot, messages }, engine, undefined, [engine], locale);
        const status = host.querySelector("[data-term-status]")!;
        expect(status.textContent).not.toMatch(/summary|turns kept|요약|보관된 턴/);
        expect(status.textContent).toContain("Old model");
        expect(status.textContent).toContain("29%");
        expect(status.textContent?.trim()).not.toMatch(/[│·]$/);
        await unmount?.();
        unmount = null;
      }
    }
  });
});
