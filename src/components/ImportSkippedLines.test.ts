// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StoreProvider } from "@/state/store";

import { AboutYouCard } from "./AboutYouCard";
import { ImportMemoryCard } from "./ImportMemoryCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PIN = "Office door PIN: 4417";
const PASSWORD = "My password is hunter2-very-secret";
type Call = { url: string; body: unknown };

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(node: ReturnType<typeof createElement>, answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    if (init?.method === "POST") calls.push(call);
    if (url === "/api/about-you" && !init?.method) return Response.json({ sources: [], declined: false });
    const body = answer(call);
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }));
  vi.stubGlobal("EventSource", class { close() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, node))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, calls };
}

const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error("missing element");
  await act(async () => (element as HTMLElement).click());
};
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);
async function type(host: HTMLElement, text: string) {
  const box = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function importThrough(card: HTMLElement, scope: "all" | "bot") {
  await click(card.querySelector("[data-import-card] button[aria-expanded]"));
  await type(card, "- Plays cello.\nSource: ChatGPT");
  if (scope === "bot") await click(button(card, "Only this bot"));
  await click(button(card, "Add to memory"));
}

it("0 flags: the saved box is today's, with no review line", async () => {
  const { host } = await mount(createElement(ImportMemoryCard, { botId: "helper", onClose: () => {} }), () => ({ source: "ChatGPT", found: 2, added: 2, duplicates: 0, hidden: 0, flagged: [] }));
  await importThrough(host, "all");
  const saved = host.querySelector("[data-import-saved]")!;
  expect(saved.textContent).toBe("Added 2 facts from ChatGPT · All my botsView in SettingsAdd another AI");
  expect(saved.querySelector("[data-import-skipped]")).toBeNull();
});

it("flags: one compact line, folded, that lists each line with Keep; Keep saves it to the scope picked", async () => {
  const { host, calls } = await mount(createElement(ImportMemoryCard, { botId: "helper", onClose: () => {} }), ({ body }) => (body as { keep?: string[] }).keep
    ? { source: "ChatGPT", found: 1, added: 1, duplicates: 0, hidden: 0, flagged: [] }
    : { source: "ChatGPT", found: 2, added: 2, duplicates: 0, hidden: 0, flagged: [PASSWORD, PIN] });
  await importThrough(host, "bot");
  const skipped = host.querySelector("[data-import-skipped]")!;
  const toggle = skipped.querySelector("button[aria-expanded]")!;
  expect(toggle.textContent).toBe("2 lines look like passwords, skipped");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await click(toggle);
  expect([...skipped.querySelectorAll("li")].map((li) => li.textContent)).toEqual([`${PASSWORD}Keep`, `${PIN}Keep`]);
  await click(skipped.querySelectorAll("li")[1]!.querySelector("button"));
  expect(calls.at(-1)).toEqual({ url: "/api/bots/helper/memory/import", body: { keep: [PIN], source: "ChatGPT" } });
  expect(skipped.querySelectorAll("li")[1]!.textContent).toBe(`${PIN}Kept`);
  expect(skipped.querySelectorAll("li")[0]!.textContent).toBe(`${PASSWORD}Keep`);
  expect(host.querySelector("[data-import-saved]")!.textContent).toContain("Added 3 facts from ChatGPT · This bot");
  // held in the open card only
  expect(JSON.stringify({ ...localStorage })).not.toContain("hunter2");
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("hunter2");
});

it("a paste of only flagged lines still opens the saved box with the review line", async () => {
  const { host } = await mount(createElement(ImportMemoryCard, { botId: "helper", onClose: () => {} }), () => ({ source: "ChatGPT", found: 0, added: 0, duplicates: 0, hidden: 0, flagged: [PIN] }));
  await importThrough(host, "all");
  expect(host.querySelector("[data-import-skipped] button")?.textContent).toBe("1 line looks like a password, skipped");
});

it("Settings > Import Memory lists flagged lines the same way and keeps one to All my bots", async () => {
  const { host, calls } = await mount(createElement(AboutYouCard), ({ body }) => (body as { keep?: string[] }).keep
    ? { source: "ChatGPT", found: 1, added: 1, duplicates: 0, hidden: 0, flagged: [], sources: [{ source: "ChatGPT", facts: ["Plays cello.", PIN] }] }
    : { source: "ChatGPT", found: 1, added: 1, duplicates: 0, hidden: 0, flagged: [PIN], sources: [{ source: "ChatGPT", facts: ["Plays cello."] }] });
  await type(host, "- Plays cello.\nSource: ChatGPT");
  await click(button(host, "Add to Memory"));
  expect(host.textContent).toContain("Added 1 new.");
  await click(host.querySelector("[data-import-skipped] button[aria-expanded]"));
  await click(button(host, "Keep"));
  expect(calls.at(-1)).toEqual({ url: "/api/about-you", body: { keep: [PIN], source: "ChatGPT" } });
  expect(host.textContent).toContain("2 facts");
  expect(host.querySelector("[data-import-skipped] li")!.textContent).toBe(`${PIN}Kept`);
});

it("Settings with 0 flags shows only today's note", async () => {
  const { host } = await mount(createElement(AboutYouCard), () => ({ source: "ChatGPT", found: 1, added: 1, duplicates: 0, hidden: 0, flagged: [], sources: [{ source: "ChatGPT", facts: ["Plays cello."] }] }));
  await type(host, "- Plays cello.\nSource: ChatGPT");
  await click(button(host, "Add to Memory"));
  expect(host.querySelector("[data-import-skipped]")).toBeNull();
});
