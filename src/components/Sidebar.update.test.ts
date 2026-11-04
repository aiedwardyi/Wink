// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateButton } from "./Sidebar";

type Frame = { kind: "hello"; resumed: boolean; cursor: string } | { kind: "update.state"; state: { status: string; version?: string } };

class Source {
  static current: Source;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
  constructor() { Source.current = this; }
  send(frame: Frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

afterEach(() => vi.unstubAllGlobals());

it("shows background update states and routes sidebar actions without a preload bridge", async () => {
  delete window.ogb;
  vi.stubGlobal("EventSource", Source);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "idle" })));
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(UpdateButton)));
    expect(Source.current).toBeDefined();
    await act(async () => Source.current.send({ kind: "hello", resumed: false, cursor: "a:1" }));
    for (const status of ["available", "downloading", "downloaded", "installing", "error"]) {
      await act(async () => Source.current.send({ kind: "update.state", state: { status, version: "1.0.229" } }));
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
      await act(async () => Source.current.send({ kind: "update.state", state: { status } }));
      expect(host.querySelector("button")).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
  }
});
