// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale, I18nProvider, persistPreference } from "@/lib/i18n";

const { mockState, mockApi } = vi.hoisted(() => {
  return {
    mockState: { config: undefined as unknown, bots: [] as unknown[] },
    mockApi: vi.fn((): Promise<unknown> => new Promise(() => {})),
  };
});

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  api: mockApi,
  useStore: () => ({ state: mockState, dispatch: () => undefined }),
}));

import { relativeTimeLabel, SavedKeys } from "./ApiKeys";
import { ROW_BUTTON } from "./SettingsPrimitives";

applyLocale("en");

const render = () => renderToStaticMarkup(createElement(I18nProvider, null, createElement(SavedKeys)));

describe("SavedKeys", () => {
  beforeEach(() => localStorage.setItem("omb-keys-open", "1"));

  it("folds the keys into one counted row and remembers the fold", async () => {
    mockState.config = { imageGen: { configured: true }, customKeys: [{ host: "api.acme.dev", name: "Acme" }] };
    localStorage.removeItem("omb-keys-open");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.body.appendChild(document.createElement("div"));
    let root = createRoot(host);
    const mount = async () => {
      root = createRoot(host);
      await act(async () => root.render(createElement(I18nProvider, null, createElement(SavedKeys))));
    };
    const head = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const removes = () => host.querySelectorAll('button[aria-label="Remove the Saved Key"]').length;
    try {
      await mount();
      expect(head().textContent).toBe("Keys2 saved");
      expect(head().getAttribute("aria-expanded")).toBe("false");
      expect(removes()).toBe(0);

      await act(async () => head().click());
      expect(head().getAttribute("aria-expanded")).toBe("true");
      expect(removes()).toBe(2);
      expect(host.textContent).toContain("Acme · api.acme.dev");
      await act(async () => root.unmount());
      await mount();
      expect(head().getAttribute("aria-expanded")).toBe("true");
      expect(removes()).toBe(2);

      await act(async () => head().click());
      expect(head().getAttribute("aria-expanded")).toBe("false");
      await act(async () => root.unmount());
      await mount();
      expect(head().getAttribute("aria-expanded")).toBe("false");
      expect(removes()).toBe(0);

      persistPreference("ko");
      await act(async () => root.unmount());
      await mount();
      expect(head().textContent).toBe("키2개 저장됨");
    } finally {
      persistPreference("en");
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("confirms deletion in-page, cancels without a request, and leaves text input usable", async () => {
    mockState.config = { imageGen: { configured: true } };
    mockApi.mockImplementation(async () => ({ uses: {}, saved: true, config: { imageGen: { configured: false } } }));
    const previousConfirm = window.confirm;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const nativeConfirm = vi.fn(() => false);
    window.confirm = nativeConfirm;
    function SettingsHarness() {
      const [open, setOpen] = useState(true);
      const [text, setText] = useState("");
      return createElement("div", null,
        open && createElement(SavedKeys),
        open && createElement("button", { onClick: () => setOpen(false) }, "Close Settings"),
        createElement("input", { "aria-label": "Message", value: text, onInput: (event) => setText(event.currentTarget.value) }),
        createElement("output", null, text),
      );
    }
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const dialog = () => document.querySelector('[role="dialog"]');
    const dialogButton = (label: string) => [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === label)!;
    try {
      await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsHarness))));
      mockApi.mockClear();
      const trash = host.querySelector<HTMLButtonElement>('button[aria-label="Remove the Saved Key"]')!;
      trash.focus();
      await act(async () => trash.click());
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(dialog()?.textContent).toContain("Remove the saved OpenAI API Key?");
      expect(document.activeElement).toBe(dialogButton("Cancel"));
      expect(mockApi).not.toHaveBeenCalled();
      await act(async () => dialogButton("Cancel").click());
      expect(dialog()).toBeNull();
      expect(mockApi).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trash);

      await act(async () => trash.click());
      await act(async () => dialogButton("Remove the Saved Key").click());
      expect(dialog()).toBeNull();
      expect(mockApi).toHaveBeenCalledTimes(1);
      expect(mockApi).toHaveBeenCalledWith("/api/credentials", { method: "POST", body: JSON.stringify({ target: "openaiImageApiKey", value: "" }) });
      expect(document.activeElement).toBe(trash);

      await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Close Settings")!.click());
      const input = host.querySelector("input")!;
      input.focus();
      await act(async () => {
        for (const character of "Typing after deletion") {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
          input.value += character;
          input.dispatchEvent(new InputEvent("input", { data: character, inputType: "insertText", bubbles: true }));
        }
      });
      expect(document.activeElement).toBe(input);
      expect(input.disabled).toBe(false);
      expect(host.querySelector("output")?.textContent).toBe("Typing after deletion");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      window.confirm = previousConfirm;
      vi.unstubAllGlobals();
      mockApi.mockReset().mockImplementation(() => new Promise(() => {}));
    }
  });

  it("lists only saved brokerable keys, never a value", () => {
    mockState.config = { imageGen: { configured: true }, xai: { configured: false }, box: { configured: true }, anthropic: { configured: true } };
    const html = render();
    expect(html).toContain("OpenAI API Key");
    expect(html).toContain("Claude API Key");
    expect(html).toContain("Not used yet");
    expect(html).toContain('aria-label="Remove the Saved Key"');
    expect(html).toContain(`class="${ROW_BUTTON}">Remove</button>`);
    expect(html).not.toContain("xAI API Key");
    expect(html).not.toContain("Box API Key");
    expect(html).not.toContain("type=\"password\"");
  });

  it("lists a custom key as name and host", () => {
    mockState.config = { customKeys: [{ host: "api.acme.dev", name: "Acme" }] };
    expect(render()).toContain("Acme · api.acme.dev");
  });

  it("hides the card when no key is saved", () => {
    mockState.config = { imageGen: { configured: false } };
    expect(render()).toBe("");
  });
});

describe("relativeTimeLabel", () => {
  it("formats the last use relative to now", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(relativeTimeLabel("2026-09-27T11:59:30Z", "en", now)).toBe("this minute");
    expect(relativeTimeLabel("2026-09-27T09:00:00Z", "en", now)).toBe("3 hours ago");
    expect(relativeTimeLabel("2026-09-26T12:00:00Z", "en", now)).toBe("yesterday");
  });
});
