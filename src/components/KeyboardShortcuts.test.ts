// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";

import { KeyboardShortcuts } from "./KeyboardShortcuts";

describe("KeyboardShortcuts", () => {
  afterEach(() => {
    persistPreference("en");
    vi.restoreAllMocks();
  });

  it.each([
    ["en", "Win32", "Ctrl", "Queue Message", "Hold Send on Phone"],
    ["ko", "Win32", "Ctrl", "답변 후 보내기", "휴대폰에서 보내기 길게 누르기"],
    ["en", "MacIntel", "Cmd", "Queue Message", "Hold Send on Phone"],
    ["ko", "MacIntel", "Cmd", "답변 후 보내기", "휴대폰에서 보내기 길게 누르기"],
  ] as const)("lists queueing in one row, with no plain Enter row, in %s on %s", (locale, platform, mod, label, hold) => {
    persistPreference(locale);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(KeyboardShortcuts)));
    const host = document.createElement("div");
    host.innerHTML = html;
    const rows = Array.from(host.querySelectorAll("dl > div"));
    const combo = (text: string) => rows.find((row) => row.querySelector("dt")?.textContent === text)?.querySelector("dd");

    expect(combo(label)?.getAttribute("aria-label")).toBe(`${mod} + Enter / ${hold}`);
    expect(rows.some((row) => row.querySelector("dd")?.getAttribute("aria-label") === "Enter")).toBe(false);
  });

  it.each([
    ["en", "Win32", "Chat", "Toggle Workers", "Alt"],
    ["ko", "Win32", "대화", "작업자 열기 / 닫기", "Alt"],
    ["en", "MacIntel", "Chat", "Toggle Workers", "Option"],
    ["ko", "MacIntel", "대화", "작업자 열기 / 닫기", "Option"],
  ] as const)("lists workers in Chat in %s on %s", (locale, platform, group, label, alt) => {
    persistPreference(locale);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(I18nProvider, null, createElement(KeyboardShortcuts)));
    const rows = [...host.querySelectorAll("dl > div")].filter((row) => row.querySelector("dt")?.textContent === label);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector("dd")?.getAttribute("aria-label")).toBe(`${alt} + W`);
    expect(rows[0].closest("dl")?.parentElement?.previousElementSibling?.textContent).toBe(group);
  });

  it("lists Toggle Model Index once with Alt+I only", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
    );

    expect(html.match(/>Toggle Model Index</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Alt + I"');
    expect(html).not.toContain("Shift + M");
  });

  it.each([
    ["en", "Win32", "Alt", "Switch to bot 1–9", "Open worker terminal 1–9"],
    ["ko", "Win32", "Alt", "1–9번째 봇으로 이동", "1–9번째 작업자 터미널 열기"],
    ["en", "MacIntel", "Option", "Switch to bot 1–9", "Open worker terminal 1–9"],
    ["ko", "MacIntel", "Option", "1–9번째 봇으로 이동", "1–9번째 작업자 터미널 열기"],
  ] as const)("lists separate bot and worker keys in %s on %s", (locale, platform, alt, bot, worker) => {
    persistPreference(locale);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(I18nProvider, null, createElement(KeyboardShortcuts)));
    const combo = (label: string) => [...host.querySelectorAll("dl > div")].find((row) => row.querySelector("dt")?.textContent === label)?.querySelector("dd")?.getAttribute("aria-label");
    expect(combo(bot)).toBe("Ctrl + 1–9");
    expect(combo(worker)).toBe(`${alt} + 1–9`);
  });

  it("names the page-scoped shortcuts and drops the terminal note", () => {
    const win = window as unknown as { ogb?: unknown };
    win.ogb = { terminal: {} };
    try {
      const html = renderToStaticMarkup(
        createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
      );
      expect(html).toContain(">Cycle Model Index Tab (in Model Index)<");
      expect(html).not.toContain(">Refresh Usage");
      expect(html).toContain(">Toggle Terminal<");

      persistPreference("ko");
      const ko = renderToStaticMarkup(
        createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
      );
      expect(ko).toContain(">모델 지표 탭 전환 (모델 지표 화면에서)<");
      expect(ko).not.toContain(">사용량 새로 고침");
      expect(ko).toContain(">터미널 열기 / 닫기<");
    } finally {
      delete win.ogb;
    }
  });

  it("lists the terminal toggle in a window with no preload", () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
    );
    expect(html).toContain(">Toggle Terminal<");
    expect(html).toContain("`");
  });

  it("keeps the compact set while hiding low-value help rows", () => {
    persistPreference("en");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(KeyboardShortcuts)),
    );

    expect(html).toContain(">Toggle Themes<");
    expect(html).toContain(">Toggle Usage<");
    expect(html).not.toContain(">Refresh Usage");
    expect(html).not.toContain('aria-label="Alt + R"');
    expect(html).not.toContain("New bot");
    expect(html).toContain("Switch to bot 1–9");
    expect(html).not.toContain("Previous bot");
    expect(html).not.toContain("Next bot");
    expect(html).not.toContain("Find in conversation");
    expect(html).not.toContain("Send message");
    expect(html).not.toContain("New line");
    expect(html).not.toContain("Edit last message");
    expect(html).not.toContain("Close a dialog or menu");
  });
});
