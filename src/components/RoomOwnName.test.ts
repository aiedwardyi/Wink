// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: mock.api,
  useStore: () => ({ state: { config: { profile: { name: "Mina Park" } } }, dispatch: mock.dispatch }),
}));

import { RoomOwnName } from "./RoomOwnName";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.clearAllMocks());

it("saves the Wink name only after IME confirmation finishes", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  mock.api.mockResolvedValue({ profile: { name: "민아" } });
  try {
    await act(async () => root.render(createElement(RoomOwnName, { name: "Mina Park" })));
    await act(async () => host.querySelector("button")!.click());
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "@민아");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true }));
    });
    expect(mock.api).not.toHaveBeenCalled();
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(mock.api).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")!.click());
    expect(mock.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ profile: { name: "민아" } }) });
    expect(mock.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { profile: { name: "민아" } } });
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels from the X without saving", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(RoomOwnName, { name: "Mina Park" })));
    await act(async () => host.querySelector("button")!.click());
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mina");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')!.click());
    expect(mock.api).not.toHaveBeenCalled();
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toContain("Mina Park");
  } finally {
    await act(async () => root.unmount());
  }
});

it("saves after a cancel that cut off an IME composition", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  mock.api.mockResolvedValue({ profile: { name: "Mina" } });
  try {
    await act(async () => root.render(createElement(RoomOwnName, { name: "Mina Park" })));
    await act(async () => host.querySelector("button")!.click());
    await act(async () => host.querySelector("input")!.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')!.click());
    await act(async () => host.querySelector("button")!.click());
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mina");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Save name"]')!.click());
    expect(mock.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ profile: { name: "Mina" } }) });
  } finally {
    await act(async () => root.unmount());
  }
});
