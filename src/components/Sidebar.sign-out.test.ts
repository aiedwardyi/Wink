// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { StoreProvider, useStore } from "@/state/store";
import type { GoogleAccountStatus } from "../../server/google-account.ts";

import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./Sidebar";

const RELAY = "aaaaaaaaaaaaaaaa.app.getwink.dev";
const EMAIL = "edward.kim.longname@example.com";
const liveEvents = () => new Response("", { headers: { "content-type": "text/event-stream" } });
let host: HTMLDivElement;
let root: Root;
let signOut: () => Promise<Response>;
let events: () => Promise<Response>;
let offline = false;
let googleAccount: GoogleAccountStatus;
let streams: Array<{ onopen: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; close: () => void }> = [];

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
    close = vi.fn();
  });
  signOut = async () => new Response('{"ok":true}', { status: 200 });
  events = async () => liveEvents();
  googleAccount = { state: "signed-in", email: EMAIL };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (offline) throw new TypeError("Failed to fetch");
    if (String(path).includes("/api/phone/sign-out")) return signOut();
    if (String(path).includes("/api/events")) return events();
    if (String(path).includes("/api/google-account")) return Response.json(googleAccount);
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

function Shell() {
  const { state } = useStore();
  return createElement(Fragment, null, createElement(Sidebar, { open: true, onClose: () => {} }), state.appSettingsOpen && createElement(SettingsModal));
}

async function renderSidebar(hostname: string, phone = false, locale: "en" | "ko" = "en") {
  const replace = vi.fn();
  vi.stubGlobal("location", Object.assign(new URL(`https://${hostname}/`), { replace }));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }));
  applyLocale(locale);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Shell))));
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
const account = () => document.querySelector("[data-account-row]");
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});
async function signOutFromAccount() {
  await click(avatar());
  await click(account()?.querySelector("button"));
}
const signOutCalls = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes("/api/phone/sign-out"));
// A lost reply lost its Clear-Site-Data, so the page asks again before it leaves.
function postsWhenLeaving(replace: ReturnType<typeof vi.fn>) {
  let posts = 0;
  replace.mockImplementation(() => {
    posts = signOutCalls().length;
  });
  return () => posts;
}

describe("signing a browser out from Settings > Account", () => {
  it.each([
    ["en", false, "Sign Out"],
    ["en", true, "Sign Out"],
    ["ko", false, "로그아웃"],
  ] as const)("opens Account from the picture with the PC's Google email and Sign Out, and lands on the sign-in page (%s, phone %s)", async (locale, phone, label) => {
    const replace = await renderSidebar(RELAY, phone, locale);
    await click(avatar());
    await settle();
    expect(avatar()?.hasAttribute("aria-haspopup")).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(account()?.textContent).toBe(`${EMAIL}${label}`);
    const column = document.querySelector(".border-l");
    if (phone) expect(account()?.parentElement?.firstElementChild).toBe(account());
    else expect(column?.children.length === 1 && column.firstElementChild === account()).toBe(true);
    await click(account()?.querySelector("button"));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(signOutCalls()).toHaveLength(1);
    expect(signOutCalls()[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it.each(["pending", "signed-out", "unavailable"] as const)("shows Sign Out alone while the PC's Google account is %s", async (state) => {
    googleAccount = { state };
    await renderSidebar(RELAY);
    await click(avatar());
    await settle();
    expect(account()?.textContent).toBe("Sign Out");
  });

  it("keeps the page and says so when the PC can't be reached", async () => {
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    const replace = await renderSidebar(RELAY);
    await signOutFromAccount();
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Couldn't sign out"));
    expect(replace).not.toHaveBeenCalled();
  });

  it("lands on the sign-in page when the reply is lost after the sign-out landed", async () => {
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    const replace = await renderSidebar(RELAY);
    const postsAtLeave = postsWhenLeaving(replace);
    await signOutFromAccount();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(postsAtLeave()).toBe(2);
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
    await act(async () => streams.at(-1)?.onopen?.());
    await signOutFromAccount();
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
    expect(replace).not.toHaveBeenCalled();

    events = async () => liveEvents();
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
    const postsAtLeave = postsWhenLeaving(replace);
    await act(async () => streams.at(-1)?.onopen?.());
    await signOutFromAccount();
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
    expect(replace).not.toHaveBeenCalled();

    events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
    await act(async () => streams.at(-1)?.onerror?.());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(postsAtLeave()).toBe(2);
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
  });

  it("stays on the dashboard through a full outage, then lands on the sign-in page once the PC says the session is gone", async () => {
    const replace = await renderSidebar(RELAY);
    signOut = async () => {
      offline = true;
      throw new TypeError("Failed to fetch");
    };
    await signOutFromAccount();
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
    await signOutFromAccount();
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
    await signOutFromAccount();
    await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Couldn't sign out"));
    expect(replace).not.toHaveBeenCalled();
  });

  it("waits for a new live stream when the old one keeps sending pings", async () => {
    const replace = await renderSidebar(RELAY);
    const oldStream = streams.at(-1)!;
    await act(async () => oldStream.onopen?.());
    const ping = () => act(async () => oldStream.onmessage?.({ data: JSON.stringify({ kind: "ping", now: Date.now() }) }));
    await ping();
    signOut = async () => {
      throw new TypeError("Failed to fetch");
    };
    events = async () => new Response("Bad gateway", { status: 502 });
    await signOutFromAccount();
    await ping();
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
    expect(streams.at(-1)).not.toBe(oldStream);
    expect(oldStream.close).toHaveBeenCalledOnce();
    await act(async () => streams.at(-1)?.onopen?.());
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
    await signOutFromAccount();
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
    await signOutFromAccount();
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
    await signOutFromAccount();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("https://app.getwink.dev/?signedout=1"));
    expect(document.querySelector('[role="status"]')?.textContent ?? "").not.toContain("Couldn't sign out");
  });

  it.each([
    ["another PC's desktop window", RELAY, () => { vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Wink/1.0 Electron/43.4.0"); }],
    ["the tailnet", "home.tail1234.ts.net", () => {}],
  ] as const)("has no Sign Out in %s, where the avatar opens Account with Sync", async (_where, hostname, setUp) => {
    setUp();
    await renderSidebar(hostname);
    await click(avatar());
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(account()).toBeNull();
    expect(document.querySelector(".border-l")?.textContent).toContain("Sync");
    expect(signOutCalls()).toHaveLength(0);
  });

  it("signs the desktop app out of Google from the account row, and stays open", async () => {
    const googleSignOut = vi.fn(async () => ({ ok: true as const }));
    Reflect.set(window, "ogb", { platform: "win32", googleAccount: { signIn: vi.fn(), cancel: vi.fn(), signOut: googleSignOut } });
    const signedIn = { state: "up-to-date", email: EMAIL, boundEmail: null, join: null, progress: null, lastSyncAt: 1 };
    const signedOut = { ...signedIn, state: "signed-out", email: null };
    let sync: typeof signedIn | typeof signedOut = signedIn;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, init) => String(path).includes("/api/google-sync") ? Response.json(sync) : base(path, init));
    const replace = await renderSidebar("127.0.0.1:3000");
    await click(avatar());
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const column = document.querySelector(".border-l");
    expect(column?.querySelector("[data-account-row]")).toBe(account());
    expect(account()?.textContent).toBe(`${EMAIL}Sign Out`);
    expect([...column!.querySelectorAll("button")].filter((button) => button.textContent === "Sign Out")).toHaveLength(1);

    sync = signedOut;
    await click(account()?.querySelector("button"));
    await settle();
    expect(googleSignOut).toHaveBeenCalledOnce();
    expect(account()?.textContent).toBe("Google Sign-in");
    expect(document.querySelector("[data-sidebar-profile-row]")).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(signOutCalls()).toHaveLength(0);
  });
});
