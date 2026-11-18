// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import App from "./App";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

const frame = () => act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });

const mount = async (phone = false) => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: ["Scout", "Map"].map((name, index) => ({ id: `b${index + 1}`, threadId: `t${index + 1}`, name, messages: [], modelSelection: { instanceId: "inst", model: "m" } })),
    groups: [], selectedId: "b1",
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn((input: string) => String(input).includes("/terminal") && !String(input).includes("pane-counts")
    ? Promise.resolve(new Response(JSON.stringify({ sessionId: "main", generation: 1, screenText: "PS>", panes: [{ sessionId: "main", main: true }] })))
    : new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  if (phone) vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") || query.includes("coarse"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  await frame();
  return {
    host,
    row: (id: string) => host.querySelector<HTMLElement>(`[data-sidebar-row-kind="bot"][data-sidebar-row-id="${id}"] [role="button"]`)!,
    composer: () => host.querySelector<HTMLTextAreaElement>("[data-orbit-composer]")!,
    backquote: () => act(async () => { (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", key: "`", ctrlKey: true, bubbles: true, cancelable: true })); }),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
    },
  };
};

it("puts the cursor in the chat box of a bot chat picked from the sidebar with Space", async () => {
  const f = await mount();
  try {
    f.row("b2").focus();
    await act(async () => { f.row("b2").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
    await frame();
    expect(f.composer().getAttribute("aria-label")).toBe("Message Map");
    expect(document.activeElement).toBe(f.composer());
  } finally { await f.unmount(); }
});

it("never focuses the chat box on a phone switch, so the keyboard stays down", async () => {
  const f = await mount(true);
  try {
    await act(async () => f.row("b2").click());
    await frame();
    expect(f.composer().getAttribute("aria-label")).toBe("Message Map");
    expect(document.activeElement).not.toBe(f.composer());
  } finally { await f.unmount(); }
});

it("hands the cursor back to the chat box when Ctrl+` closes the terminal, and leaves it there on a switch", async () => {
  const f = await mount();
  try {
    f.composer().focus();
    await f.backquote();
    await vi.waitFor(() => expect(f.host.querySelector('.orbit-terminal-overlay[data-open="true"] pre')).toBeTruthy());
    await vi.waitFor(() => expect(document.activeElement?.closest(".orbit-terminal-overlay")).toBeTruthy());
    await f.backquote();
    await frame();
    expect(document.activeElement).toBe(f.composer());
    await act(async () => f.row("b2").click());
    await frame();
    expect(document.activeElement).toBe(f.composer());
    expect(f.composer().getAttribute("aria-label")).toBe("Message Map");
  } finally { await f.unmount(); }
});

it("shows the docked terminal the moment it opens, so Ctrl+` can focus it", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
  document.head.append(style);
  const dock = document.body.appendChild(document.createElement("div"));
  dock.className = "orbit-terminal-overlay";
  dock.setAttribute("data-side", "");
  dock.setAttribute("data-open", "true");
  const rules: CSSStyleRule[] = [];
  const walk = (list: CSSRuleList) => {
    for (const rule of [...list]) {
      if (rule instanceof CSSMediaRule) { if (rule.conditionText.includes("min-width: 768px")) walk(rule.cssRules); }
      else if (rule instanceof CSSStyleRule && dock.matches(rule.selectorText)) rules.push(rule);
    }
  };
  walk(style.sheet!.cssRules);
  const weight = (rule: CSSStyleRule) => (rule.selectorText.match(/[.[:]/g) ?? []).length;
  // Visibility only flips when its transition starts, and a hidden element takes no focus.
  const delay = [...rules].sort((a, b) => weight(a) - weight(b)).reduce((held, rule) => {
    const own = rule.style.getPropertyValue("transition-delay");
    const short = rule.style.getPropertyValue("transition");
    if (own) return own;
    if (short === "none") return "0s";
    const visibility = short.split(",").map((part) => part.trim()).find((part) => part.startsWith("visibility"));
    return visibility ? visibility.split(/\s+/)[2] ?? "0s" : held;
  }, "0s");
  expect(delay).toBe("0s");
  style.remove();
  dock.remove();
});
