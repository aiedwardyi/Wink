// @vitest-environment happy-dom
// The engine header's account picker: passive inspection by name and number, keyed by id. The old paged account columns are now the desk's rows.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { AccountPicker } from "./UsageAccounts";

const accounts = [
  { id: "acct-1", name: "Claude 1", number: 1 },
  { id: "acct-2", name: "Claude 2", number: 2 },
  { id: "acct-3", name: "Studio", number: 3 },
  { id: "acct-4", name: "Claude 4", number: 4 },
];
let root: Root;
let host: HTMLDivElement;
let picked: string[];
const picker = () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
const openMenu = () => host.querySelector('[role="menu"]:not([data-closing])');

function Harness({ list = accounts }: { list?: typeof accounts }) {
  const [viewed, setViewed] = useState("acct-1");
  return createElement("div", null,
    createElement(AccountPicker, { accounts: list, viewedId: viewed, select: (id: string) => { picked.push(id); setViewed(id); } }),
    createElement("button", { type: "button", "data-after": "" }, "After"));
}
async function render(list = accounts) {
  await act(async () => root.render(createElement(I18nProvider, null, createElement(Harness, { list }))));
}

beforeEach(() => {
  persistPreference("en");
  picked = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("names accounts only and reports picks by id", async () => {
  await render();
  expect(picker().textContent).toBe("Claude 1");
  await act(async () => picker().click());
  expect(items().map((item) => item.textContent)).toEqual(["1Claude 1", "2Claude 2", "3Studio", "4Claude 4"]);
  expect(items().map((item) => item.querySelector("[data-tile]")?.textContent)).toEqual(["1", "2", "3", "4"]);
  expect(host.querySelector('[role="menu"] svg')).toBeNull();
  expect(items().map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
  await act(async () => items()[2]!.click());
  expect(picked).toEqual(["acct-3"]);
  expect(picker().textContent).toBe("Studio");
  expect(document.activeElement).toBe(picker());
});

it("tags Main in the list in English and Korean", async () => {
  const list = accounts.map((account) => ({ ...account, main: account.id === "acct-2" }));
  for (const [locale, main] of [["en", "Main"], ["ko", "기본"]] as const) {
    persistPreference(locale);
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(list);
    await act(async () => picker().click());
    expect(items().map((item) => item.textContent)).toEqual(["1Claude 1", `2Claude 2${main}`, "3Studio", "4Claude 4"]);
    expect(items()[1]!.getAttribute("aria-label")).toBe(`Claude 2 ${main}`);
  }
});

it("supports menu arrow keys, Home, End, Escape, outside dismissal and focus return", async () => {
  await render();
  await act(async () => picker().click());
  expect(host.querySelector('[role="menu"]')!.id).toBe(picker().getAttribute("aria-controls"));
  expect(document.activeElement).toBe(items()[0]);
  await act(async () => items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement).toBe(items()[1]);
  await act(async () => items()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  expect(document.activeElement).toBe(items()[0]);
  await act(async () => items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  expect(document.activeElement).toBe(items()[3]);
  await act(async () => items()[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(items()[0]);
  await act(async () => items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(items()[3]);
  await act(async () => items()[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(openMenu()).toBeNull();
  expect(document.activeElement).toBe(picker());
  await act(async () => picker().click());
  await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(openMenu()).toBeNull();
  expect(picked).toEqual([]);
});

it("closes an open menu when its trigger is pressed again", async () => {
  await render();
  await act(async () => picker().click());
  await act(async () => {
    picker().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    picker().focus();
  });
  expect(picker().getAttribute("aria-expanded")).toBe("true");
  await act(async () => picker().click());
  expect(picker().getAttribute("aria-expanded")).toBe("false");
  expect(openMenu()).toBeNull();
});

it.each([false, true])("closes once on a second full press of its trigger and scales only while no menu is mounted (reduced motion=%s)", async (reduce) => {
  vi.useFakeTimers();
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  onTestFinished(() => media.mockRestore());
  await render();
  const box = picker().parentElement!;
  const scales = () => box.classList.contains("has-[>button:active]:scale-[0.97]");
  expect(scales()).toBe(true);
  await act(async () => picker().click());
  expect(picker().getAttribute("aria-expanded")).toBe("true");
  expect(scales()).toBe(false);
  const flips: (string | null)[] = [];
  const watch = new MutationObserver((records) => flips.push(...records.map((record) => record.oldValue)));
  watch.observe(picker(), { attributeFilter: ["aria-expanded"], attributeOldValue: true });
  const seen: string[] = [];
  for (const press of [
    () => picker().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    () => picker().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    () => picker().focus(),
    () => picker().dispatchEvent(new PointerEvent("pointerup", { bubbles: true })),
    () => picker().dispatchEvent(new MouseEvent("mouseup", { bubbles: true })),
    () => picker().click(),
  ]) {
    await act(async () => { press(); });
    seen.push(`${picker().getAttribute("aria-expanded")}:${scales()}`);
  }
  expect(seen).toEqual(["true:false", "true:false", "true:false", "true:false", "true:false", `false:${reduce}`]);
  expect(openMenu()).toBeNull();
  expect(host.querySelector('[role="menu"]') === null).toBe(reduce);
  await act(async () => { vi.advanceTimersByTime(PRESENCE_EXIT_MS); });
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(scales()).toBe(true);
  flips.push(...watch.takeRecords().map((record) => record.oldValue));
  watch.disconnect();
  expect(flips).toEqual(["true"]);
  expect(picker().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(picker());
});

it("keeps the menu open on blur without a related target", async () => {
  await render();
  await act(async () => picker().click());
  await act(async () => items()[0]!.blur());
  expect(document.activeElement).toBe(document.body);
  expect(picker().getAttribute("aria-expanded")).toBe("true");
  await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(picker().getAttribute("aria-expanded")).toBe("false");
});

it.each([false, true])("closes on Tab out of the menu with shift=%s", async (shift) => {
  await render();
  await act(async () => picker().click());
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  await act(async () => items()[0]!.dispatchEvent(event));
  await act(async () => (shift ? picker() : host.querySelector<HTMLButtonElement>("[data-after]")!).focus());
  expect(event.defaultPrevented).toBe(false);
  expect(picker().getAttribute("aria-expanded")).toBe("false");
});

it("falls back to the first account when the viewed id is gone", async () => {
  await render(accounts.slice(1));
  expect(picker().textContent).toBe("Claude 2");
});

it("names the trigger for screen readers in Korean", async () => {
  persistPreference("ko");
  await render();
  expect(picker().getAttribute("aria-label")).toContain("Claude 1");
  expect(picker().getAttribute("aria-label")).not.toBe("Claude 1");
});
