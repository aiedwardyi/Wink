// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LazyView } from "@/components/LazyView";
import { STALE_RELOAD_KEY } from "../../shared/stale-reload";
import { lazyView, useStaleBuildReload } from "./stale-build";

// a module script would make happy-dom try to load it
const entry = (name: string) => `<script type="text/plain" src="/assets/${name}"></script>`;

let reload: ReturnType<typeof vi.fn<() => void>>;
let fetch: ReturnType<typeof vi.fn>;
let unmount: (() => Promise<void>) | null = null;

beforeEach(() => {
  document.head.innerHTML = entry("index-AAAA1111.js");
  fetch = vi.fn(async () => new Response(entry("index-BBBB2222.js")));
  vi.stubGlobal("fetch", fetch);
  reload = vi.fn<() => void>();
  vi.spyOn(location, "reload").mockImplementation(reload);
});

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  document.body.innerHTML = "";
});

function Page({ viewOpen }: { viewOpen: boolean }) {
  useStaleBuildReload(true, viewOpen);
  return null;
}

async function mount(viewOpen: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (open: boolean) => act(async () => root.render(createElement(Page, { viewOpen: open })));
  await render(viewOpen);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return render;
}

async function foreground() {
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await act(async () => new Promise((done) => setTimeout(done, 10)));
}

describe("useStaleBuildReload", () => {
  it("waits while a view is open and reloads once it closes", async () => {
    const render = await mount(true);
    await foreground();
    expect(reload).not.toHaveBeenCalled();
    await render(false);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await render(true);
    await render(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => HTMLElement]>([
    ...["date", "time", "datetime-local", "month", "week"].map((type): [string, () => HTMLElement] => [
      `${type} input`,
      () => Object.assign(document.createElement("input"), { type }),
    ]),
    ["select", () => document.createElement("select")],
  ])("counts a focused %s as typing", async (_name, create) => {
    await mount(false);
    const field = create();
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    await foreground();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => field.blur());
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe("lazyView", () => {
  async function show(view: ReturnType<typeof createElement>, fallback = "wait") {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(LazyView, { fallback, children: view })));
    unmount = async () => act(async () => root.unmount());
    return host;
  }

  it("mounts a preloaded view on its first frame, without the fallback", async () => {
    const View = lazyView(async () => ({ default: ({ name }: { name: string }) => createElement("p", null, `hi ${name}`) }));
    await View.preload();
    const host = await show(createElement(View, { name: "Atlas" }));
    expect(host.textContent).toBe("hi Atlas");
  });

  // act() flushes past React's 300 ms reveal hold, so this one runs on the real scheduler
  it("shows a view nobody preloaded as soon as its chunk arrives", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    type Late = { default: () => ReturnType<typeof createElement> };
    let arrive!: (module: Late) => void;
    const View = lazyView(() => new Promise<Late>((resolve) => (arrive = resolve)));
    const host = document.createElement("div");
    const root = createRoot(host);
    root.render(createElement(LazyView, { fallback: "wait", children: createElement(View) }));
    unmount = async () => root.unmount();
    await vi.waitFor(() => expect(host.textContent).toBe("wait"));
    arrive({ default: () => createElement("p", null, "late") });
    await vi.waitFor(() => expect(host.textContent).toBe("late"), { timeout: 150, interval: 5 });
  });

  it("reloads once on a failed chunk, then shows the view's Reload card", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const View = lazyView(async () => Promise.reject(new Error("chunk gone")));
    const first = await show(createElement(View));
    await act(async () => {});
    expect(reload).toHaveBeenCalledTimes(1);
    expect(first.textContent).toBe("wait");
    await unmount?.();
    expect(sessionStorage.getItem(STALE_RELOAD_KEY)).not.toBeNull();
    const second = await show(createElement(View));
    await act(async () => {});
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.querySelector('[role="alert"]')).not.toBeNull();
  });
});
