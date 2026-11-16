// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThumb } from "@/lib/media-thumbs";
import { ChatMarkdown } from "./ChatMarkdown";
import { MediaViewerProvider } from "./MediaViewerProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
vi.mock("@/lib/media-thumbs", () => ({ useThumb: vi.fn() }));

let frame: (src: string) => string = () => "blob:poster";
type See = (entries: { isIntersecting: boolean }[]) => void;
let observers: { see: See }[] = [];
const seeAll = () => act(async () => {
  for (const observer of observers) observer.see([{ isIntersecting: true }]);
});
const src = (path: string) => `/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`;

describe("video cards", () => {
  let host: HTMLElement;
  let root: Root;
  const card = () => host.querySelector<HTMLButtonElement>("[data-show-card]")!;
  const mount = (path: string) => act(async () => root.render(createElement(StrictMode, null, createElement(MediaViewerProvider, { threadId: "t1", messages: [],
    children: createElement(ChatMarkdown, { text: `Here it is:\n[${path.split("\\").pop()}](<${path}>)`, threadId: "t1" }) }))));

  beforeEach(() => {
    frame = () => "blob:poster";
    observers = [];
    vi.mocked(useThumb).mockImplementation((src: string, clip?: boolean, wait?: boolean) => clip && !wait ? frame(src) : undefined);
    vi.stubGlobal("IntersectionObserver", class {
      constructor(public see: See) { observers.push(this); }
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile: vi.fn(async () => {}) } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "ogb");
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(["C:\\pokkey\\out\\ep2-p3-whole-5-sound-4.mp4", "C:\\w\\clip.webm", "C:\\w\\clip.mov"])("shows the first frame of %s with a play badge once on screen", async (path) => {
    await mount(path);
    expect(card().querySelector("img")).toBeNull();
    expect(vi.mocked(useThumb).mock.calls.every(([, , wait]) => wait)).toBe(true);
    await seeAll();
    expect(vi.mocked(useThumb)).toHaveBeenCalledWith(src(path), true, false);
    expect(card().querySelector("img")?.getAttribute("src")).toBe("blob:poster");
    expect(card().querySelector("[data-play-badge]")).not.toBeNull();
    expect(card().querySelector("video")).toBeNull();
    const ext = path.slice(path.lastIndexOf(".") + 1);
    expect(card().textContent).toBe(`${path.split("\\").pop()}${ext.toUpperCase()}`);
  });

  it("opens the clip in the viewer and plays it", async () => {
    const path = "C:\\pokkey\\out\\ep2-p3-whole-5-sound-4.mp4";
    await mount(path);
    await seeAll();
    await act(async () => card().click());
    const video = document.querySelector<HTMLVideoElement>("[data-media-viewer] video")!;
    expect(video.getAttribute("src")).toBe(src(path));
    expect(video.autoplay).toBe(true);
    expect(video.controls).toBe(true);
    expect(document.querySelector("[data-media-viewer] img")).toBeNull();
    expect(window.ogb!.openFile).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>("[data-media-viewer] a[download]")!.focus();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(video);
  });

  it("keeps the file icon and opens the file the old way when no frame can be made", async () => {
    frame = (src) => src;
    const path = "C:\\w\\gone.mp4";
    await mount(path);
    await seeAll();
    expect(card().querySelector("img")).toBeNull();
    expect(card().querySelector("[data-play-badge]")).toBeNull();
    expect(card().querySelector("svg")).not.toBeNull();
    await act(async () => card().click());
    expect(document.querySelector("[data-media-viewer]")).toBeNull();
    expect(window.ogb!.openFile).toHaveBeenCalledWith(path, undefined);
  });
});
