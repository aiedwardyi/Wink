// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { StoreProvider } from "./store";

const RELAY = "aaaaaaaaaaaaaaaa.app.getwink.dev";
let host: HTMLDivElement;
let root: Root;
let events: () => Promise<Response>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage = null;
    constructor() {
      queueMicrotask(() => this.onerror?.());
    }
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (String(path).startsWith("/api/events")) return events();
    if (String(path).includes("/api/bots")) return new Response(JSON.stringify({ bots: [], groups: [], computerControl: {} }));
    return new Response("{}", { status: 200 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete window.ogb;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openTab(hostname: string) {
  const replace = vi.fn();
  vi.stubGlobal("location", Object.assign(new URL(`https://${hostname}/`), { replace }));
  await act(async () => root.render(createElement(StoreProvider, null, null)));
  return replace;
}

const probes = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).startsWith("/api/events"));

it("sends an open tab whose session was signed out elsewhere to the page a reload reaches", async () => {
  events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
  const replace = await openTab(RELAY);
  await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/pair"));
});

it.each([
  ["a network blip", async () => { throw new TypeError("Failed to fetch"); }],
  ["a server error", async () => new Response("", { status: 502 })],
  ["a live stream", async () => new Response("", { status: 200 })],
])("keeps the dashboard on %s", async (_case, reply) => {
  events = reply;
  const replace = await openTab(RELAY);
  await vi.waitFor(() => expect(probes().length).toBeGreaterThan(0));
  await act(async () => {
    await Promise.all(vi.mocked(fetch).mock.results.map((result) => result.value).map((value) => Promise.resolve(value).catch(() => null)));
  });
  expect(replace).not.toHaveBeenCalled();
});

it("asks nothing outside a relay browser", async () => {
  events = async () => new Response('{"error":"unauthorized","code":"SIGNED_OUT"}', { status: 401 });
  const replace = await openTab("home.tail1234.ts.net");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(probes()).toHaveLength(0);
  expect(replace).not.toHaveBeenCalled();
});
