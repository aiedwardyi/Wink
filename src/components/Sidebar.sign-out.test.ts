// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { StoreProvider } from "@/state/store";

import { Sidebar } from "./Sidebar";

const RELAY = "aaaaaaaaaaaaaaaa.app.getwink.dev";
let host: HTMLDivElement;
let root: Root;
let signOut: () => Promise<Response>;
let events: () => Promise<Response>;
let offline = false;
let streams: Array<{ onopen: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: { data: string }) => void) | null }> = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  offline = false;
  streams = [];
  vi.stubGlobal("EventSource", class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() {
      streams.push(this);
    }
    close() {}
  });
  signOut = async () => new Response('{"ok":true}', { status: 200 });
  events = async () => new Response("", { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (offline) throw new TypeError("Failed to fetch");
    if (String(path).includes("/api/phone/sign-out")) return signOut();
    if (String(path).includes("/api/events")) return events();
    if (String(path).includes("/api/bots")) return new Response(JSON.stringify({ bots: [], groups: [], computerControl: {} }));
    return new Response("{}", { status: 200 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.clear();
  delete window.ogb;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  applyLocale("en");
  delete window.ogb;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderSidebar(hostname: string, phone = false, locale: "en" | "ko" = "en") {
  const replace = vi.fn();
  vi.stubGlobal("location", Object.assign(new URL(`https://${hostname}/`), { replace }));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  applyLocale(locale);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => {} }))));
  await act(async () => {
    await Promise.all(vi.mocked(fetch).mock.results.map((result) => result.value));
  });
  return replace;
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const avatar = () => document.querySelector("[data-sidebar-profile-row] button");
const menuItems = () => [...document.querySelectorAll('[data-profile-menu] [role="menuitem"]')];
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});
const signOutCalls = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes("/api/phone/sign-out"));

describe("signing a browser out from the avatar", () => {
  it.each([
    ["en", false, ["Account", "Sign Out"]],
    ["en", true, ["Account", "Sign Out"]],
    ["ko", false, ["계정", "로그아웃"]],
  ] as const)("ends the avatar menu with Sign Out and lands on the sign-in page (%s, phone %s)", async (locale, phone, labels) => {
    const replace = await renderSidebar(RELAY, phone, locale);
    await click(avatar());
    expect(document.querySelector('[data-profile-menu][role="menu"]')).not.toBeNull();
    expect(menuItems().map((item) => item.textContent)).toEqual(labels);
    await click(menuItems().at(-1));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(signOutCalls()).toHaveLength(1);
    expect(signOutCalls()[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("keeps the page and says so when the PC can't be reached", async () => {
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    const replace = await renderSidebar(RELAY);
    await click(avatar());
    await click(menuItems().at(-1));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Couldn't sign out"));
    expect(replace).not.toHaveBeenCalled();
  });

  it("lands on the sign-in page when the reply is lost after the sign-out landed", async () => {
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    const replace = await renderSidebar(RELAY);
    await click(avatar());
    await click(menuItems().at(-1));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
  });

  // Through the relay a PC that is gone drops the socket, before or after it saved the sign-out alike.
  it.each([
    ["drops the connection", async () => { throw new TypeError("Failed to fetch"); }],
    ["is answered for by the gateway with 503", async () => new Response("PC unavailable", { status: 503 })],
  ])("claims nothing while the PC %s, then says it failed once the PC still has the session", async (_case, gone) => {
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    events = gone;
    const replace = await renderSidebar(RELAY);
    await click(avatar());
    await click(menuItems().at(-1));
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
    expect(replace).not.toHaveBeenCalled();

    events = async () => new Response("", { status: 200 });
    await act(async () => streams.at(-1)?.onopen?.());
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Couldn't sign out"));
    expect(replace).not.toHaveBeenCalled();
    // still signed in, so a later sign-out from elsewhere lands where a reload would
    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    await act(async () => streams.at(-1)?.onerror?.());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/pair"));
  });

  it.each([
    ["drops the connection", async () => { throw new TypeError("Failed to fetch"); }],
    ["is answered for by the gateway with 503", async () => new Response("PC unavailable", { status: 503 })],
  ])("never says sign-out failed when the PC saved it and then %s, and lands on the sign-in page once it is back", async (_case, gone) => {
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    events = gone;
    const replace = await renderSidebar(RELAY);
    await click(avatar());
    await click(menuItems().at(-1));
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
    expect(replace).not.toHaveBeenCalled();

    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    await act(async () => streams.at(-1)?.onerror?.());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
  });

  it("stays on the dashboard through a full outage, then lands on the sign-in page once the PC says the session is gone", async () => {
    const replace = await renderSidebar(RELAY);
    signOut = async () => {
      offline = true;
      throw new TypeError("Failed to fetch");
    };
    await click(avatar());
    await click(menuItems().at(-1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(replace).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");

    offline = false;
    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    await act(async () => streams.at(-1)?.onerror?.());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("waits out an outage that starts right after a successful sign-out, rather than open a page that can't load", async () => {
    const replace = await renderSidebar(RELAY);
    signOut = async () => {
      offline = true;
      return new Response('{"ok":true}', { status: 200 });
    };
    await click(avatar());
    await click(menuItems().at(-1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(replace).not.toHaveBeenCalled();

    offline = false;
    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    await act(async () => streams.at(-1)?.onerror?.());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["drops the connection", async () => { throw new TypeError("Failed to fetch"); }],
    ["is answered for by the gateway with 503", async () => new Response("PC unavailable", { status: 503 })],
  ])("says it failed when the live stream opened while the PC %s on the check", async (_case, gone) => {
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    events = async () => {
      await act(async () => streams.at(-1)?.onopen?.());
      return gone();
    };
    const replace = await renderSidebar(RELAY);
    await click(avatar());
    await click(menuItems().at(-1));
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Couldn't sign out"));
    expect(replace).not.toHaveBeenCalled();
  });

  it("says it failed when the live stream never dropped and only pings arrive", async () => {
    const replace = await renderSidebar(RELAY);
    await act(async () => streams.at(-1)?.onopen?.());
    const ping = () => act(async () => streams.at(-1)?.onmessage?.({ data: JSON.stringify({ kind: "ping", now: Date.now() }) }));
    await ping();
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    events = async () => new Response("Bad gateway", { status: 502 });
    await click(avatar());
    await click(menuItems().at(-1));
    await ping();
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Couldn't sign out"));
    expect(replace).not.toHaveBeenCalled();
  });

  it("says it failed as soon as the stream reopens, while the gateway still holds the check", async () => {
    const replace = await renderSidebar(RELAY);
    await act(async () => streams.at(-1)?.onopen?.());
    const opened = streams.length;
    signOut = async () => {
      await act(async () => streams.at(-1)?.onerror?.());
      throw new TypeError("Failed to fetch");
    };
    const held: Array<(response: Response) => void> = [];
    events = () => new Promise((resolve) => held.push(resolve));
    await click(avatar());
    await click(menuItems().at(-1));
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");

    await vi.waitFor(() => expect(streams.length).toBeGreaterThan(opened));
    await act(async () => streams.at(-1)?.onopen?.());
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Couldn't sign out"));
    expect(replace).not.toHaveBeenCalled();
    await act(async () => held.forEach((resolve) => resolve(new Response("PC unavailable", { status: 503 }))));
  });

  it("claims nothing when the PC cut the open stream as it saved the sign-out, then lands on the sign-in page", async () => {
    const replace = await renderSidebar(RELAY);
    await act(async () => streams.at(-1)?.onopen?.());
    const opened = streams.length;
    signOut = async () => {
      await act(async () => streams.at(-1)?.onerror?.());
      throw new TypeError("Failed to fetch");
    };
    events = async () => {
      throw new TypeError("Failed to fetch");
    };
    await click(avatar());
    await click(menuItems().at(-1));
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
    expect(replace).not.toHaveBeenCalled();

    // the reconnect is refused
    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    await vi.waitFor(() => expect(streams.length).toBeGreaterThan(opened));
    await act(async () => streams.at(-1)?.onerror?.());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
  });

  it("lands on the sign-in page when the PC dropped the session but answered with an error", async () => {
    signOut = async () => new Response('{"error":"save-failed"}', { status: 500 });
    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    const replace = await renderSidebar(RELAY);
    await click(avatar());
    await click(menuItems().at(-1));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
  });

  it.each([
    ["the desktop app", "127.0.0.1:3000", () => { Reflect.set(window, "ogb", { platform: "win32" }); }],
    ["another PC's desktop window", RELAY, () => { vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Wink/1.0 Electron/43.4.0"); }],
    ["the tailnet", "home.tail1234.ts.net", () => {}],
  ] as const)("has no Sign Out in %s, where the avatar still opens Account", async (_where, hostname, setUp) => {
    setUp();
    await renderSidebar(hostname);
    await click(avatar());
    expect(document.querySelector("[data-profile-menu]")).toBeNull();
    expect(document.body.textContent).not.toContain("Sign Out");
    expect(signOutCalls()).toHaveLength(0);
  });
});
