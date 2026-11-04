// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateButton } from "./Sidebar";

type Frame = { kind: "hello"; resumed: boolean; cursor: string } | { kind: "update.state"; state: { status: string; version?: string } };

class Source {
  static current: Source | undefined;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
  constructor() { Source.current = this; }
  send(frame: Frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

afterEach(() => {
  delete window.ogb;
  Source.current = undefined;
  vi.unstubAllGlobals();
});

it("shows background update states and routes sidebar actions when the desktop updater bridge is unavailable", async () => {
  window.ogb = { platform: "win32" } as NonNullable<Window["ogb"]>;
  vi.stubGlobal("EventSource", Source);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "idle" })));
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UpdateButton)));
    expect(Source.current).toBeDefined();
    await act(async () => Source.current!.send({ kind: "hello", resumed: false, cursor: "a:1" }));
    for (const status of ["available", "downloading", "downloaded", "installing", "error"]) {
      await act(async () => Source.current!.send({ kind: "update.state", state: { status, version: "1.0.229" } }));
      const button = host.querySelector("button");
      expect(button, status).not.toBeNull();
      expect(button!.disabled).toBe(["downloading", "installing"].includes(status));
      if (["available", "downloaded", "error"].includes(status)) {
        await act(async () => button!.click());
        const action = status === "available" ? "download" : status === "downloaded" ? "install" : "check";
        expect(fetch).toHaveBeenCalledWith(`/api/update/${action}`, expect.objectContaining({ method: "POST" }));
      }
    }
    for (const status of ["idle", "checking"]) {
      await act(async () => Source.current!.send({ kind: "update.state", state: { status } }));
      expect(host.querySelector("button")).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([390, 1280])("hides desktop updates from browser clients at width %s", async (width) => {
  delete window.ogb;
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("EventSource", Source);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "available", version: "1.0.229" })));
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UpdateButton)));
    for (const status of ["available", "downloading", "downloaded", "installing", "error"]) {
      await act(async () => Source.current?.send({ kind: "update.state", state: { status, version: "1.0.229" } }));
      expect(host.querySelector("button"), status).toBeNull();
    }
    expect(Source.current).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
