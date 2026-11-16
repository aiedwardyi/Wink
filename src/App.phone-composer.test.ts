// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import App from "./App";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

// iOS zooms the whole page into any field whose text is under 16 px.
it("sets the message box text to 16 px below the phone breakpoint", async () => {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [{ id: "b1", threadId: "t1", name: "Scout", messages: [], modelSelection: { instanceId: "inst", model: "m" } }],
    groups: [],
    selectedId: "b1",
  }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(App)));
    const box = await vi.waitFor(() => {
      const found = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Scout"]');
      expect(found).toBeTruthy();
      return found!;
    });
    const sizes = box.className.split(" ").filter((name) => /(^|:)text-\[\d+px\]$/.test(name));
    expect(sizes).toEqual(["text-[15px]", "max-md:text-[16px]"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});
