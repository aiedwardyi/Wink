// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n-catalog";
import { I18nProvider } from "@/lib/i18n";
import { AboutYouCard } from "./AboutYouCard";

const sources = [{ source: "ChatGPT", facts: ["The user is Dana Park; call her Dana.", "Speaks Korean and English."] }];

describe("About You card", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let saved: typeof sources;
  const request = vi.fn();
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    saved = [];
    request.mockReset();
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/about-you" && init?.method === "POST") {
        saved = sources;
        return Response.json({ source: "ChatGPT", found: 2, added: 2, duplicates: 0, hidden: 1, full: 0, sources });
      }
      if (path === "/api/about-you") return Response.json({ sources: saved });
      if (path === "/api/about-you/sources/ChatGPT" && init?.method === "DELETE") return Response.json({ sources: [] });
      return Response.json({ error: `no route ${path}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    localStorage.setItem("omb-locale", "en");
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  const render = () => act(async () => root.render(createElement(I18nProvider, null, createElement(AboutYouCard))));
  const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label)!;
  const click = (label: string) => act(async () => button(label).click());

  it("copies the prompt, then adds one paste for every bot with no bot to pick", async () => {
    await render();
    expect(host.textContent).toContain("Bring what ChatGPT, Claude, Gemini, Grok or Muse knows about you.");
    expect(host.textContent).not.toContain("Import Memory");
    expect(button("Add to Memory").disabled).toBe(true);
    expect(host.textContent).toContain("I'm moving to a new AI assistant called Wink.");
    expect(host.textContent).not.toContain("Copy Prompt");
    await click("Copy Prompt");
    expect(writeText).toHaveBeenCalledWith(en["aboutYou.prompt"]);
    expect(button("Copied").querySelector("svg")).not.toBeNull();

    const box = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "- The user is Dana Park; call her Dana.\nSource: ChatGPT");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Add to Memory");
    const post = request.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/about-you");
    expect(JSON.parse(String(post[1].body))).toEqual({ text: "- The user is Dana Park; call her Dana.\nSource: ChatGPT" });
    expect(host.textContent).toContain("Every bot knows this.");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Added 2 new. Left out 1 that looked like passwords or keys.");
    expect(host.querySelector("[data-about-you-source]")?.textContent).toContain("From ChatGPT2 facts");
    expect(host.querySelector("textarea")).toBeNull();
    expect(button("Add More")).toBeDefined();
  });

  it("keeps the copy tap area real and shows focus only for the keyboard", async () => {
    await render();
    const copy = button("Copy Prompt");
    expect(copy.className).toContain("[@media(pointer:coarse)]:after:content-['']");
    expect(copy.classList.contains("hover:bg-raised-hover")).toBe(true);
    const prompt = host.querySelector<HTMLElement>("[tabindex='0']")!;
    expect(prompt.className).not.toMatch(/(^|\s)focus:outline-none/);
    expect(prompt.className).toContain("focus-visible:outline-none");
    expect(prompt.className).toContain("focus-visible:ring-2 focus-visible:ring-accent/50");
  });

  it("shows the whole prompt on a distinct surface", async () => {
    await render();
    const prompt = host.querySelector<HTMLElement>("[tabindex='0']")!;
    expect(prompt.textContent).toBe(en["aboutYou.prompt"]);
    expect(prompt.className).not.toMatch(/\b(max-h-|overflow-)/);
    expect(prompt.parentElement!.className).toContain("bg-raised");
    expect(host.querySelector("textarea")!.className).toContain("bg-inset");
  });

  const type = (value: string) => act(async () => {
    const box = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const later = () => {
    let release!: () => void;
    return { gate: new Promise<void>((resolve) => { release = resolve; }), release: () => act(async () => release()) };
  };

  it("keeps an import when the first list answers after it", async () => {
    const first = later();
    const served = request.getMockImplementation()!;
    let lists = 0;
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path !== "/api/about-you" || init?.method || lists++) return served(path, init);
      await first.gate;
      return Response.json({ sources: [] });
    });
    await render();
    await type("- The user is Dana Park; call her Dana.");
    await click("Add to Memory");
    expect(host.querySelector("[data-about-you-source]")?.textContent).toContain("From ChatGPT");
    await first.release();
    expect(host.querySelector("[data-about-you-source]")?.textContent).toContain("From ChatGPT");
  });

  it("locks the paste while it imports", async () => {
    const post = later();
    const served = request.getMockImplementation()!;
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") await post.gate;
      return served(path, init);
    });
    await render();
    await type("- The user is Dana Park; call her Dana.");
    await click("Add to Memory");
    expect(host.querySelector("textarea")!.disabled).toBe(true);
    await post.release();
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("removes a source", async () => {
    saved = sources;
    await render();
    expect(host.textContent).toContain("From ChatGPT");
    await click("Remove");
    expect(request.mock.calls.some(([path, init]) => path === "/api/about-you/sources/ChatGPT" && init?.method === "DELETE")).toBe(true);
    expect(host.textContent).toContain("Bring what ChatGPT, Claude, Gemini, Grok or Muse knows about you.");
  });
});
