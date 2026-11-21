import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

// What the dial's open costs: one style and layout pass for the face, and a first open warmed at idle. The nightly felt legs time the same press.
const L5 = ["low", "medium", "high", "xhigh", "max"] as const;
let root: Root | undefined;

function engine(instanceId: string, driverKind: string, ids: string[]): InstanceInfo {
  return {
    instanceId, driverKind, displayName: instanceId,
    snapshot: { state: "available", authenticated: true },
    models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
    capabilities: { effortLevels: [...L5] },
  };
}

function desktop() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: !query.includes("reduce") && query.split(", ").some((part) => !part.startsWith("(max-width")),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

// A fresh module graph per test: the warm runs once per page.
async function picker() {
  vi.resetModules();
  const { ModelPickerControl } = await import("./ModelPicker");
  const { I18nProvider } = await import("@/lib/i18n");
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
    engine("codex", "codex", ["gpt-6.2-sol", "gpt-6-luna"]),
    engine("grok", "grokAgent", ["grok-4.7"]),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Dial", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high", mode: "pinned" } };
  const control = (open: boolean) => createElement(ModelPickerControl, { key: "picker", bot, store: { state: { instances, selectedId: "bot-1" }, dispatch: vi.fn(), refreshInstances: async () => undefined }, defaultOpen: open, dial: true });
  return async (...opens: boolean[]) => {
    if (!root) {
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    }
    await act(async () => root!.render(createElement(I18nProvider, null, ...opens.map((open, i) => ({ ...control(open), key: `picker-${i}` })))));
  };
}

const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  Element.prototype.animate = vi.fn(() => ({ cancel: vi.fn() } as unknown as Animation));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "requestIdleCallback");
  Reflect.deleteProperty(window, "cancelIdleCallback");
});

describe("opening the model dial", () => {
  it("measures its stage before the face mounts, so the face is laid out once at its real size", async () => {
    desktop();
    const measured: boolean[] = [];
    const rect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("model-dial")) measured.push(this.querySelector(".dial-card") !== null);
      return rect.call(this);
    });
    const render = await picker();
    await render(true);
    expect(document.querySelectorAll("[data-model-picker-content] .dial-card")).toHaveLength(5);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured).not.toContain(true);
  });

  it("leaves the stage alone in the frames after it opens, so no second pass restyles the whole face", async () => {
    desktop();
    const render = await picker();
    await render(true);
    const stage = document.querySelector(".dial-stage")!;
    const changed: string[] = [];
    const observer = new MutationObserver((records) => records.forEach((record) => changed.push(record.attributeName ?? "")));
    observer.observe(stage, { attributes: true });
    for (let i = 0; i < 4; i++) await frame();
    observer.disconnect();
    expect(changed).toEqual([]);
    expect(stage.hasAttribute("data-boot")).toBe(false);
  });
});

describe("the dial's idle warm", () => {
  let idle: Array<() => void>;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // SAFETY: the picker only schedules function callbacks.
    vi.spyOn(window, "setTimeout").mockImplementation((fn, ms) => setTimeout(fn as () => void, ms));
    idle = [];
    frames = [];
    const request = (callback: FrameRequestCallback) => frames.push(callback);
    const cancel = (id: number) => { frames[id - 1] = () => undefined; };
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(request);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancel);
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: vi.fn((callback: () => void) => idle.push(callback)) });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: vi.fn() });
  });

  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const runIdle = () => act(async () => { idle.splice(0).forEach((callback) => callback()); });
  const warm = () => document.querySelector<HTMLElement>("[data-dial-warm]");
  const paint = () => act(async () => { const due = frames.splice(0); frames.push(...due.map(() => () => undefined)); due.forEach((callback) => callback(performance.now())); });

  it("mounts one hidden, inert face for a frame at idle, once per page", async () => {
    desktop();
    const render = await picker();
    await render(false, false);
    await wait(1999);
    expect(idle).toHaveLength(0);
    await wait(1);
    expect(warm()).toBeNull();
    await runIdle();
    expect(document.querySelectorAll("[data-dial-warm]")).toHaveLength(1);
    expect(warm()!.querySelectorAll(".dial-card")).toHaveLength(5);
    expect(warm()!.getAttribute("aria-hidden")).toBe("true");
    expect(warm()!.hasAttribute("inert")).toBe(true);
    expect(warm()!.style.visibility).toBe("hidden");
    expect(warm()!.style.pointerEvents).toBe("none");
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
    await paint();
    expect(warm()).toBeNull();
    await render(false, false, false);
    await wait(10000);
    await runIdle();
    expect(warm()).toBeNull();
  });

  it("skips the warm once a picker has opened", async () => {
    desktop();
    const render = await picker();
    await render(false);
    await wait(1000);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
    await wait(10000);
    await runIdle();
    expect(document.querySelector("[data-dial-warm]")).toBeNull();
    expect(document.querySelectorAll("[data-model-picker-content] .dial-card")).toHaveLength(5);
  });

  it("never warms the list picker", async () => {
    desktop();
    localStorage.setItem("omb-model-picker-view", "list");
    const render = await picker();
    await render(false);
    await wait(10000);
    await runIdle();
    expect(warm()).toBeNull();
  });
});
