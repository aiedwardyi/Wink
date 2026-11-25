// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { leaveSignedOut } from "@/lib/signed-out";

import { SNAPSHOT_CACHE_KEY } from "./snapshot-cache";
import { StoreProvider, useStore } from "./store";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("leaves no snapshot behind once signed out, even from the pagehide that follows", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (path: string) =>
    String(path).includes("/api/bots") ? Response.json({ bots: [], groups: [], computerControl: {} }) : Response.json({}),
  ));
  const streams: Array<{ onmessage: ((event: { data: string; lastEventId: string }) => void) | null }> = [];
  vi.stubGlobal("EventSource", class {
    onopen = null;
    onerror = null;
    onmessage = null;
    constructor() {
      streams.push(this);
    }
    close() {}
  });
  vi.stubGlobal("location", Object.assign(new URL("https://aaaaaaaaaaaaaaaa.app.getwink.dev/"), { replace: vi.fn() }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store: ReturnType<typeof useStore> | null = null;
  function Probe() {
    store = useStore();
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await act(async () => streams.at(-1)?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "s:1" }), lastEventId: "" }));
  await vi.waitFor(() => expect(store?.state.hydrated).toBe(true));
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem(SNAPSHOT_CACHE_KEY)).not.toBeNull();

  await leaveSignedOut();
  window.dispatchEvent(new Event("pagehide"));
  expect(location.replace).toHaveBeenCalledWith("/pair");
  expect(localStorage.getItem(SNAPSHOT_CACHE_KEY)).toBeNull();
  await act(async () => root.unmount());
});
