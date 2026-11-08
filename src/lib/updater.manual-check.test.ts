// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { useManualCheck } from "./updater";

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

async function mount(check: () => Promise<unknown>) {
  vi.stubGlobal("ogb", { updater: { check } });
  let latest!: ReturnType<typeof useManualCheck>;
  function Probe() {
    latest = useManualCheck("idle");
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  unmount = async () => act(async () => root.unmount());
  return () => latest;
}

it("acknowledges a check that finished", async () => {
  const hook = await mount(() => Promise.resolve());
  await act(async () => hook().check());
  expect(hook().acknowledged).toBe(true);
});

it("does not acknowledge a check that was rejected", async () => {
  const hook = await mount(() => Promise.reject(new Error("offline")));
  await act(async () => hook().check());
  expect(hook().acknowledged).toBe(false);
});
