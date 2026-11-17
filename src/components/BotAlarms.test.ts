import "./ProfileFields.test-dom.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider, persistPreference } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { BotAlarms } from "./BotAlarms";

const here = dirname(fileURLToPath(import.meta.url));
let root: Root | undefined;
let host: HTMLDivElement;

function routine(partial: Partial<Routine>): Routine {
  return {
    id: "r1", name: "Morning brief", prompt: "brief me", botId: "atlas", runOn: "maus", enabled: true,
    schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    durationMinutes: 10, nextRunAt: null, createdAt: 1, updatedAt: 1, ...partial,
  };
}

function render(routines: Routine[], locale: "en" | "ko" = "en", onDelete: (routineId: string) => void = () => undefined) {
  persistPreference(locale);
  applyLocale(locale);
  act(() => root!.render(createElement(I18nProvider, null, createElement(BotAlarms, { routines, onDelete }))));
}

const toggle = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]");

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  persistPreference("en");
  applyLocale("en");
  vi.unstubAllGlobals();
});

describe("Alarms line in Bot details", () => {
  it("shows nothing when the bot has no routines", () => {
    render([]);
    expect(host.textContent).toBe("");
  });

  it("shows the count and opens the bot's routines on tap", () => {
    const at = new Date(2026, 10, 20, 15, 0).getTime();
    render([
      routine({}),
      routine({ id: "r2", name: "Standup", enabled: false, schedule: { type: "daily", time: "10:30", weekdays: [1, 3, 5] } }),
      routine({ id: "r3", name: "Dentist", schedule: { type: "once", at } }),
    ]);
    expect(toggle()!.textContent).toContain("Alarms");
    expect(toggle()!.textContent).toContain("3");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("Morning brief");
    act(() => toggle()!.click());
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    const rows = [...host.querySelectorAll("[data-alarm]")].map((row) => row.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Morning brief");
    expect(rows[0]).toContain("Every day");
    expect(rows[0]).toMatch(/9:00/);
    expect(rows[1]).toContain("Standup");
    expect(rows[1]).toContain("Mon, Wed, Fri");
    expect(rows[1]).toMatch(/10:30/);
    expect(rows[1]).toContain("Paused");
    expect(rows[0]).not.toContain("Paused");
    expect(rows[2]).toContain("Dentist");
    expect(rows[2]).toContain("Nov 20");
    expect(rows[2]).toMatch(/3:00/);
  });

  it("leaves out a bot's self-set wakes", () => {
    render([routine({}), routine({ id: "w1", name: "Wake", wake: true, schedule: { type: "once", at: Date.now() + 60_000 } })]);
    expect(toggle()!.textContent).toContain("1");
    act(() => toggle()!.click());
    expect([...host.querySelectorAll("[data-alarm]")].map((row) => row.textContent)).toEqual([expect.stringContaining("Morning brief")]);
    render([routine({ id: "w1", name: "Wake", wake: true, schedule: { type: "once", at: Date.now() + 60_000 } })]);
    expect(host.textContent).toBe("");
  });

  it("speaks Korean", () => {
    render([routine({ enabled: false })], "ko");
    expect(toggle()!.textContent).toContain("알람");
    act(() => toggle()!.click());
    const row = host.querySelector("[data-alarm]")!.textContent!;
    expect(row).toContain("매일");
    expect(row).toContain("일시 중지됨");
  });

  it("deletes a routine from its trash button, no confirm step", () => {
    const onDelete = vi.fn();
    render([routine({}), routine({ id: "r2", name: "Standup" })], "en", onDelete);
    act(() => toggle()!.click());
    const trash = host.querySelectorAll<HTMLButtonElement>("[data-alarm] button");
    expect(trash).toHaveLength(2);
    expect(trash[1].getAttribute("aria-label")).toBe("Delete Standup");
    act(() => trash[1].click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("r2");
  });

  it("reveals the trash on hover and focus, always on touch", () => {
    render([routine({})]);
    act(() => toggle()!.click());
    const cls = host.querySelector("[data-alarm] button")!.className;
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("group-hover:opacity-100");
    expect(cls).toContain("focus-visible:opacity-100");
    expect(cls).toContain("pointer-coarse:opacity-100");
  });

  it("is fed from this bot's routines in Bot details, with no sidebar entry", () => {
    const panel = readFileSync(join(here, "SettingsPanel.tsx"), "utf8");
    expect(panel).toContain("routines={state.routines.filter((each) => each.botId === bot.id)}");
    expect(panel).toContain("`/api/routines/${routineId}`, { method: \"DELETE\" }");
    expect(readFileSync(join(here, "Sidebar.tsx"), "utf8")).not.toMatch(/BotAlarms|bot\.alarms/);
  });
});
