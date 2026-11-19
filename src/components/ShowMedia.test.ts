// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { forgetMedia, type MediaWire } from "@/lib/media-index";
import { useThumb } from "@/lib/media-thumbs";
import { closeShow, showFolder, showItem, showMedia, useMediaThread, useShowItem, type FolderListing, type ShowItem } from "@/lib/show-pane";
import type { MediaSource } from "@/lib/show-media";
import { usePresence } from "@/lib/use-presence";
import type { Message } from "@/state/store";
import { ShowPane } from "./ShowPane";

vi.mock("./ShowPdf", () => ({ default: () => null }));
// every cell asks for its thumb on each render, so the calls count the grid's renders
vi.mock("@/lib/media-thumbs", async (load) => {
  const real = await load<typeof import("@/lib/media-thumbs")>();
  return { useThumb: vi.fn((src: string, clip?: boolean) => real.useThumb(src, clip)) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const upload: Message = { id: "u1", role: "user", kind: "text", at: 1, text: 'see\n<attached-image path="C:\\att\\abc-1.png" />\n<attached-file path="C:\\att\\notes.docx" name="notes.docx" size="2048" />' };
const reply: Message = { id: "b1", role: "bot", kind: "text", at: 2, text: "Here: [chart.png](C:\\w\\chart.png), [deck.pdf](C:\\w\\deck.pdf), [data.zip](C:\\w\\data.zip)" };
const id = (n: number) => String(n).padStart(24, "f");
const roomFiles = [
  { id: id(3), name: "photo.png", type: "image/png", bytes: 10, at: 3, sender: "Mina" },
  { id: id(2), name: "plan.pdf", type: "application/pdf", bytes: 10, at: 2, sender: "Mina" },
  { id: id(1), name: "sheet.xlsx", type: "application/octet-stream", bytes: 10, at: 1, sender: "Host" },
];
const NOVEMBER = new Date(2026, 10, 20, 12).getTime();
const DAY = 86_400_000;

type Entry = [messageId: string, at: number, kind: string, name: string, ref: string];
const wire = (entries: Entry[], v = "1"): MediaWire => ({
  v,
  ids: entries.map((entry) => entry[0]),
  at: entries.map((entry) => Math.floor(entry[1] / 1000)),
  kind: entries.map((entry) => entry[2]).join(""),
  name: entries.map((entry) => entry[3]),
  ref: entries.map((entry) => entry[4]),
  size: entries.map(() => null),
});
// newest first, two a day back from late November 2026
const shots = (count: number) => wire(Array.from({ length: count }, (_, n): Entry => [`m${n}`, NOVEMBER - n * DAY / 2, "l", `shot-${n}.png`, `C:\\w\\shot-${n}.png`]));

let root: Root;
let host: HTMLElement;
let shown: ShowItem | null = null;
let calls: string[] = [];
let room: { files: unknown[] } = { files: roomFiles };
let media: Record<string, MediaWire> = {};
const sizes = ["clientWidth", "clientHeight"].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!] as const);

beforeEach(() => {
  calls = [];
  room = { files: roomFiles };
  media = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("&size=")) return Response.json({ size: 300 });
    const asked = url.match(/^\/api\/threads\/([^/?]+)\/media\?paged=1(?:&v=(.+))?$/);
    if (asked) {
      const answer = media[asked[1]!] ?? wire([]);
      return Response.json(asked[2] === answer.v ? { v: answer.v } : answer);
    }
    if (url.endsWith("/files")) return Response.json({ ...room, used: 0, capacity: 1, error: null });
    return new Response(null, { status: 206 });
  }));
  // happy-dom has no layout; the media scroller reads as a 412 x 600 pane
  for (const [name, size] of [["clientWidth", 412], ["clientHeight", 600]] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { return (this as HTMLElement).classList.contains("show-media-scroll") ? size : 0; } });
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => closeShow());
  applyLocale("en");
  forgetMedia();
  delete window.ogb;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of ["videoWidth", "videoHeight"]) delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[name];
  for (const [name, descriptor] of sizes) Object.defineProperty(HTMLElement.prototype, name, descriptor);
});

function Pane({ source, closing }: { source: MediaSource; closing?: boolean }) {
  const item = useShowItem();
  const media = useMediaThread() === source.threadId;
  shown = item;
  return item || media ? createElement(ShowPane, { item: item ?? undefined, media, source, hidden: false, closing }) : null;
}

// as the app holds it: the last open pane stays mounted, marked closing, for its exit
function Presence({ source }: { source: MediaSource }) {
  const item = useShowItem();
  const media = useMediaThread() === source.threadId;
  const pane = usePresence(item || media ? { item: item ?? undefined, media, source } : null);
  return pane.mounted && pane.value ? createElement(ShowPane, { ...pane.value, hidden: false, closing: pane.closing }) : null;
}

const render = (source: MediaSource) => act(async () => root.render(createElement(Pane, { source })));
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((each) => each.textContent === name)!;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
const thumbs = () => [...host.querySelectorAll("[data-media-grid] img")].map((img) => img.getAttribute("src")!);
const months = () => [...host.querySelectorAll("[data-media-month]")].map((head) => head.textContent);
const names = () => [...host.querySelectorAll("[data-media-file]")].map((row) => row.querySelector("span span")!.textContent);
const row = (name: string) => [...host.querySelectorAll("[data-media-file]")].find((each) => each.querySelector("span span")!.textContent === name)!;
const tiles = () => [...host.querySelectorAll("[data-media-grid] [data-media-key]")].map((tile) => tile.getAttribute("title"));
const retry = () => [...host.querySelectorAll("button")].find((each) => each.textContent === "Retry");
const scroller = () => host.querySelector<HTMLElement>(".show-media-scroll")!;
const pointer = (el: Element, type: string, clientY: number) => act(async () => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientY })); });
const chat: MediaSource = { threadId: "t1", messages: [upload, reply] };
const clipChat = (name: string): MediaSource => ({ threadId: "t1", messages: [{ id: "c1", role: "bot", kind: "text", at: 1, text: `Cut: [${name}](C:\\w\\${name})` }] });
const hover = (el: Element, type: string, pointerType = "mouse") => act(async () => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType })); });
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

class Shrinker {
  onmessage?: (event: { data: unknown }) => void;
  postMessage({ id }: { id: number }) { setTimeout(() => this.onmessage?.({ data: { id, blob: new Blob(["frame"]) } })); }
  terminate() {}
}

// happy-dom has no media pipeline: a clip's metadata and seek, or its error, land a tick after its src
function frames(ok: boolean) {
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("Worker", Shrinker);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close() {} })));
  for (const [name, value] of [["videoWidth", 640], ["videoHeight", 360]] as const) Object.defineProperty(HTMLVideoElement.prototype, name, { configurable: true, value });
  vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(function (this: HTMLMediaElement) {
    setTimeout(() => {
      if (!ok) return this.onerror?.(new Event("error"));
      this.onloadedmetadata?.(new Event("loadedmetadata"));
      this.onseeked?.(new Event("seeked"));
    });
  });
}
const deck: ShowItem = { threadId: "t1", path: "C:\\w\\deck.pdf", kind: "pdf" };

it("switches between Show and Media", async () => {
  await act(async () => showItem(deck));
  await render(chat);
  expect(tab("Show").getAttribute("aria-selected")).toBe("true");
  await click(tab("Media"));
  await settle();
  expect(tab("Media").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("[data-show-media]")).not.toBeNull();
  await click(tab("Show"));
  expect(tab("Show").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector(".show-frame-name")?.textContent).toBe("deck.pdf");
});

it("lists a chat's images and files newest first, the ones since it loaded on top", async () => {
  media.t1 = wire([["u1", 1, "a", "abc-1.png", ""], ["u1", 1, "f", "notes.docx", "C:\\att\\notes.docx"]]);
  await act(async () => showItem(deck));
  await render(chat);
  await click(tab("Media"));
  await settle();
  expect(thumbs()).toEqual([
    "/api/threads/t1/linked-file?path=" + encodeURIComponent("C:\\w\\chart.png"),
    "/api/attachments/abc-1.png",
  ]);
  await click(tab("Files"));
  expect(names()).toEqual(["deck.pdf", "data.zip", "notes.docx"]);
});

it("an image opens full size, a showable file shows, the rest open as before", async () => {
  const openFile = vi.fn(async () => {});
  window.ogb = { openFile } as unknown as typeof window.ogb;
  await act(async () => showItem(deck));
  await render(chat);
  await click(tab("Media"));
  await settle();
  await click(host.querySelector("[data-media-grid] button"));
  expect(document.querySelector("[data-media-viewer]")).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click(tab("Files"));
  await click(row("data.zip"));
  expect(openFile).toHaveBeenCalledWith("C:\\w\\data.zip");
  await click(row("deck.pdf"));
  expect(tab("Show").getAttribute("aria-selected")).toBe("true");
  expect(shown).toEqual(deck);
});

it("loads the timeline on open and a linked size when its row appears", async () => {
  media.t1 = wire([["b0", 0, "l", "first.pdf", "C:\\w\\first.pdf"]]);
  await act(async () => showItem(deck));
  await render({ ...chat, hasMore: true });
  await settle();
  expect(calls).toEqual([]);
  await click(tab("Media"));
  await settle();
  expect(calls).toEqual(["/api/threads/t1/media?paged=1"]);
  await click(tab("Files"));
  await settle();
  expect(names().at(-1)).toBe("first.pdf");
  expect(row("first.pdf").textContent).toContain("300 B");
  await click(tab("Show"));
  await click(tab("Media"));
  await settle();
  expect(calls.filter((url) => !url.includes("&size="))).toEqual(["/api/threads/t1/media?paged=1", "/api/threads/t1/media?paged=1&v=1"]);
  expect(calls.filter((url) => url.includes("&size="))).toEqual(Array(2).fill("/api/threads/t1/media?v=1&size=0"));
  expect(names().at(-1)).toBe("first.pdf");
});

it("renders the first page while older media is loading", async () => {
  let finish!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => { finish = resolve; });
  const initial = wire([["b2", 2000, "l", "new.png", "C:\\w\\new.png"]]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/threads/t1/media?paged=1") return Response.json({ ...initial, head: "b2", next: 1 });
    if (url === "/api/threads/t1/media?v=1&page=1") return older;
    return new Response(null, { status: 206 });
  }));

  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [
    { id: "b2", role: "bot", kind: "text", at: 2000, text: "Working" },
  ] });
  await settle();
  expect(tiles()).toEqual(["new.png"]);

  finish(Response.json(wire([["b1", 1000, "l", "old.png", "C:\\w\\old.png"]])));
  await settle();
  expect(tiles()).toEqual(["new.png", "old.png"]);
});

it("keeps the complete list through a reopen while a new version is paging", async () => {
  const old: Entry = ["b1", 1000, "l", "old.pdf", "C:\\w\\old.pdf"];
  const photo: Entry = ["b2", 2000, "l", "old.png", "C:\\w\\old.png"];
  let finish!: (page: MediaWire) => void;
  const older = new Promise<MediaWire>((resolve) => { finish = resolve; });
  let pageStarted: Promise<void> | undefined;
  let startPage: (() => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith("page=1")) {
      startPage?.();
      return Response.json(await older);
    }
    if (url.includes("&size=")) {
      if (!pageStarted) return Response.json({ size: 300 });
      await pageStarted;
      return Response.json({ error: "media version expired" }, { status: 409 });
    }
    if (url.endsWith("v=2")) return Response.json({ v: "2" });
    if (url.includes("v=")) return Response.json({ ...wire([], "2"), head: "b3", next: 1 });
    return Response.json(wire([photo, old]));
  }));
  await act(async () => showItem(deck));
  await render({ ...chat, messages: [] });
  await click(tab("Media"));
  await settle();
  await click(tab("Files"));
  expect(names()).toEqual(["old.pdf"]);

  for (let n = 0; n < 2; n++) {
    pageStarted = new Promise<void>((resolve) => { startPage = resolve; });
    await click(tab("Show"));
    await click(tab("Media"));
    await settle();
    expect(calls.filter((url) => url.endsWith("page=1"))).toHaveLength(n + 1);
    expect(calls.filter((url) => url.includes("?paged=1"))).toHaveLength(n + 2);
    expect(names()).toEqual(["old.pdf"]);
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("[data-show-media]")?.hasAttribute("aria-busy")).toBe(false);
  }

  finish(wire([photo, ["b1", 1000, "f", "updated.pdf", "C:\\w\\updated.pdf"]], "2"));
  await settle();
  expect(names()).toEqual(["updated.pdf"]);
});

it("refreshes once when visible sizes expire and uses the refreshed slots", async () => {
  const first: Entry = ["b1", 1000, "l", "first.pdf", "C:\\w\\first.pdf"];
  const second: Entry = ["b2", 2000, "l", "second.pdf", "C:\\w\\second.pdf"];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("v=1&size=")) return Response.json({ error: "media version expired" }, { status: 409 });
    if (url.includes("v=2&size=")) return Response.json({ size: url.endsWith("size=1") ? 300 : 600 });
    if (url.includes("paged=1&v=1")) return Response.json(wire([second, first], "2"));
    return Response.json(wire([first, second]));
  }));
  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [] });
  await settle();
  expect(calls.filter((url) => url === "/api/threads/t1/media?paged=1&v=1")).toHaveLength(1);
  expect(row("first.pdf").textContent).toContain("300 B");
  expect(row("second.pdf").textContent).toContain("600 B");
});

it("cancels size requests once their rows scroll out of the grid", async () => {
  const entries = Array.from({ length: 1_000 }, (_, n): Entry => [
    "b" + n, NOVEMBER, "l", "file-" + n + ".pdf", "C:\\w\\file-" + n + ".pdf",
  ]);
  const pending: Array<AbortSignal | undefined> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (!url.includes("&size=")) return Response.json(wire(entries));
    const signal = options?.signal ?? undefined;
    pending.push(signal);
    return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }));
  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [] });
  await settle();
  const previous = pending.slice();
  expect(previous.length).toBeGreaterThan(0);
  await act(async () => { scroller().scrollTop = 40_000; scroller().dispatchEvent(new Event("scroll")); });
  expect(pending.length).toBeGreaterThan(previous.length);
  expect(previous.map((signal) => signal?.aborted)).toEqual(previous.map(() => true));
});

it.each([409, 503])("recovers the complete index when a continuation returns %s", async (status) => {
  const old = wire([["b1", 1000, "l", "old.png", "C:\\w\\old.png"]], "2");
  let snapshot = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const params = new URL(url, "http://x").searchParams;
    if (params.has("snapshot")) { snapshot = true; return Response.json([old]); }
    if (params.has("page")) return Response.json(null, { status });
    return Response.json({ ...wire([]), head: "b2", next: 1 });
  }));

  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [] });
  await settle();
  expect(snapshot).toBe(true);
  expect(tiles()).toEqual(["old.png"]);
});

it("includes a file streamed into the current head while older pages are pending", async () => {
  const head: Message = { id: "b2", role: "bot", kind: "text", at: 2000, text: "Working" };
  let finish!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("page=") ? older : Response.json({ ...wire([]), head: head.id, next: 1 })));
  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [head] });
  await settle();

  await render({ ...chat, messages: [{ ...head, text: "[plot.png](C:\\w\\plot.png)" }] });
  expect(tiles()).toEqual(["plot.png"]);
  finish(Response.json(wire([])));
  await settle();
});

it("publishes older history in one update while keeping the newest page usable", async () => {
  const picture = (n: number) => wire([[`b${n}`, n * 1000, "l", `picture-${n}.png`, `C:\\w\\picture-${n}.png`]]);
  let finish!: (response: Response) => void;
  const last = new Promise<Response>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("page=2")) return last;
    if (url.includes("page=1")) return Response.json({ ...picture(2), next: 2 });
    return Response.json({ ...picture(3), head: "b3", next: 1 });
  }));

  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [] });
  await settle();
  expect(tiles()).toEqual(["picture-3.png"]);
  finish(Response.json(picture(1)));
  await settle();
  expect(tiles()).toEqual(["picture-3.png", "picture-2.png", "picture-1.png"]);
});

it("keeps an audio row playing when an older photo arrives", async () => {
  const initial = wire([["b2", 2000, "l", "audio.mp3", "C:\\w\\audio.mp3"]]);
  let finish!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("size=")) return Response.json({ size: null });
    if (url.includes("page=")) return older;
    return Response.json({ ...initial, head: "b2", next: 1 });
  }));

  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [] });
  await settle();
  await click(row("audio.mp3"));
  const playing = host.querySelector("audio");
  expect(playing).not.toBeNull();
  finish(Response.json(wire([["b1", 1000, "l", "photo.png", "C:\\w\\photo.png"]])));
  await settle();
  expect(tab("Files").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("audio")).toBe(playing);
  await click(tab("Photos"));
  expect(tiles()).toEqual(["photo.png"]);
});

it("shows only the indexed files while older pages load and the head is off this branch", async () => {
  const streamed: Message = { id: "b9", role: "bot", kind: "text", at: 3000, text: "[plot.png](C:\\w\\plot.png)" };
  let finish!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("page=") ? older : Response.json({ ...wire([["b2", 2000, "l", "new.png", "C:\\w\\new.png"]]), head: "b2", next: 1 })));
  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [streamed] });
  await settle();
  expect(tiles()).toEqual(["new.png"]);

  finish(Response.json(wire([])));
  await settle();
  expect(tiles()).toEqual(["plot.png", "new.png"]);
});

it("clears Retry once an automatic refresh loads the complete index", async () => {
  const report: Entry = ["b1", 1000, "l", "report.pdf", "C:\\w\\report.pdf"];
  let expire!: () => void;
  const expiring = new Promise<void>((resolve) => { expire = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("v=1&size=")) { await expiring; return Response.json({ error: "media version expired" }, { status: 409 }); }
    if (url.includes("v=2&size=")) return Response.json({ size: 300 });
    if (url.includes("page=") || url.includes("snapshot=")) return new Response(null, { status: 503 });
    if (url.includes("paged=1&v=1")) return Response.json(wire([report], "2"));
    return Response.json({ ...wire([report]), head: "b2", next: 1 });
  }));
  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [] });
  await settle();
  expect(retry()).toBeDefined();

  expire();
  await settle();
  expect(names()).toEqual(["report.pdf"]);
  expect(retry()).toBeUndefined();
});

it("restores Retry when the reload after a failed history also fails", async () => {
  let reload = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("page=") || url.includes("snapshot=") || reload) return new Response(null, { status: 503 });
    return Response.json({ ...wire([]), head: "b2", next: 1 });
  }));
  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [] });
  await settle();
  expect(retry()).toBeDefined();

  reload = true;
  await click(retry()!);
  expect(retry()).toBeUndefined();
  await vi.waitFor(async () => { await settle(); expect(retry()).toBeDefined(); }, { timeout: 3_000 });
});

// Only the very first of the unloaded messages brings a file.
function longChat(older: number, fail = 0) {
  const last = Math.ceil(Math.max(0, older - 255) / 2048);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (fail-- > 0) return new Response(null, { status: 503 });
    if (url.includes("&size=")) return Response.json({ size: null });
    const params = new URL(url, "http://x").searchParams;
    if (url.includes("/media")) {
      const page = Number(params.get("page"));
      return Response.json(page === last
        ? wire([["h0", 0, "l", "first.pdf", "C:\\w\\first.pdf"]])
        : { ...wire([]), head: reply.id, next: page + 1 });
    }
    const before = params.get("before")!;
    const end = before === "u1" ? older : Number(before.slice(1));
    const start = Math.max(0, end - 1_000);
    return Response.json({ hasMore: start > 0, messages: Array.from({ length: end - start }, (_, n): Message => ({ id: `h${start + n}`, role: "bot", kind: "text", at: 0, text: start + n ? "old" : "[first.pdf](C:\\w\\first.pdf)" })) });
  }));
}

it("lists the first file of a chat past 5,000 older messages", async () => {
  longChat(6_000);
  await act(async () => showMedia("t1"));
  await render({ ...chat, hasMore: true });
  for (let i = 0; i < 4; i++) await settle();
  await click(tab("Files"));
  expect(names()).toContain("first.pdf");
  expect(calls.filter((url) => url.includes("page=") && !url.includes("size="))).toHaveLength(3);
});

it("asks once more when the timeline fails to load, without reopening Media", async () => {
  longChat(2_500, 1);
  await act(async () => showMedia("t1"));
  await render({ ...chat, hasMore: true });
  for (let i = 0; i < 4; i++) await settle();
  await act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));
  for (let i = 0; i < 4; i++) await settle();
  await click(tab("Files"));
  expect(names()).toContain("first.pdf");
  expect(calls.filter((url) => url === "/api/threads/t1/media?paged=1")).toHaveLength(2);
});

it("keeps the grid as it is while a reply streams, and adds a file the moment it lands", async () => {
  await act(async () => showMedia("t1"));
  await render(chat);
  await settle();
  const img = host.querySelector("[data-media-grid] img");
  const renders = vi.mocked(useThumb).mock.calls.length;
  const plain: Message = { id: "b2", role: "bot", kind: "text", at: 3, text: "thinking" };
  await render({ ...chat, messages: [upload, reply, plain] });
  await render({ ...chat, messages: [upload, reply, { ...plain, text: "thinking more" }] });
  expect(vi.mocked(useThumb).mock.calls.length).toBe(renders);
  expect(host.querySelector("[data-media-grid] img")).toBe(img);
  await render({ ...chat, messages: [upload, reply, { ...plain, text: "done: [new.png](C:\\w\\new.png)" }] });
  expect(host.querySelector("[data-media-grid] img")?.getAttribute("src")).toContain("new.png");
});

it("lists a room's files from the room, and shows its PDFs", async () => {
  const source: MediaSource = { threadId: "r-thread", roomId: "r1", messages: [] };
  await act(async () => showItem({ threadId: "r-thread", path: "plan.pdf", kind: "pdf", src: `/api/rooms/r1/files/${id(2)}` }));
  await act(async () => closeShow());
  await render(source);
  const { togglePane } = await import("@/lib/show-pane");
  await act(async () => togglePane("r-thread"));
  await click(tab("Media"));
  await settle();
  expect(calls).toContain("/api/rooms/r1/files");
  expect(host.querySelector("[data-media-grid] img")?.getAttribute("src")).toBe(`/api/rooms/r1/files/${id(3)}/preview`);
  expect(host.querySelector("[data-media-grid] button")?.getAttribute("data-media-key")).toBe(id(3));
  await click(tab("Files"));
  const sheet = row("sheet.xlsx");
  expect(sheet.getAttribute("data-media-key")).toBe(id(1));
  const saved = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await click(sheet);
  expect((saved.mock.contexts as HTMLAnchorElement[]).map((link) => [link.getAttribute("href"), link.download])).toEqual([[`/api/rooms/r1/files/${id(1)}`, "sheet.xlsx"]]);
  await click(row("plan.pdf"));
  expect(shown).toEqual({ threadId: "r-thread", path: "plan.pdf", kind: "pdf", src: `/api/rooms/r1/files/${id(2)}` });
});

it("a room's pane has no Map tab, a bot chat's does", async () => {
  const room: MediaSource = { threadId: "r-thread", roomId: "r1", messages: [] };
  await act(async () => root.render(createElement(ShowPane, { media: true, source: room, hidden: false })));
  expect(tab("Map")).toBeUndefined();
  await act(async () => root.render(createElement(ShowPane, { media: true, source: chat, botId: "b1", hidden: false })));
  expect(tab("Map")).toBeDefined();
});

it("says so when there are no files yet, in English and Korean", async () => {
  room = { files: [] };
  await act(async () => showMedia("t9"));
  await render({ threadId: "t9", messages: [] });
  await settle();
  expect(host.querySelector("[data-show-media]")?.textContent).toBe("No files yet");
  expect(tab("Show").disabled).toBe(true);
  applyLocale("ko");
  await render({ threadId: "t9", roomId: "r1", messages: [] });
  await settle();
  expect(host.querySelector(".show-media-empty")?.textContent).toBe("아직 파일이 없어요");
  expect(tab("미디어")).toBeDefined();
});

it("mounts only the rows on screen out of 2,000 files, with the full height known at once", async () => {
  media.t1 = shots(2_000);
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [] });
  await settle();
  const first = thumbs();
  expect(first.length).toBeGreaterThan(8);
  expect(first.length).toBeLessThan(60);
  expect(first[0]).toContain("shot-0.png");
  // 3 columns of 129px cells and a 6px gap: 667 rows, plus a head for each month
  expect(Number.parseFloat(host.querySelector<HTMLElement>("[data-media-grid]")!.style.height)).toBeGreaterThan(667 * 135);
  await act(async () => { scroller().scrollTop = 45_000; scroller().dispatchEvent(new Event("scroll")); });
  const later = thumbs();
  expect(later.length).toBeLessThan(60);
  expect(later).not.toContain(first[0]);
  expect(Number(later[0]!.match(/shot-(\d+)/)![1])).toBeGreaterThan(900);
});

it("heads each month with a label that sticks, in English and Korean", async () => {
  media.t1 = wire([
    ["m2", NOVEMBER, "l", "late.png", "C:\\w\\late.png"],
    ["m1", NOVEMBER - 30 * DAY, "l", "early.png", "C:\\w\\early.png"],
    ["m0", NOVEMBER - 31 * DAY, "l", "early.pdf", "C:\\w\\early.pdf"],
  ]);
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [] });
  await settle();
  expect(months()).toEqual(["November 2026", "October 2026"]);
  expect(readFileSync("src/components/ShowPane.css", "utf8")).toMatch(/\.show-media-month \{[^}]*position: sticky; top: 0/);
  act(() => root.unmount());
  root = createRoot(host);
  applyLocale("ko");
  await render({ threadId: "t1", messages: [] });
  await settle();
  expect(months()).toEqual(["2026년 11월", "2026년 10월"]);
});

it("dragging the scroll thumb shows the month beside it until 600 ms after release", async () => {
  media.t1 = shots(2_000);
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [] });
  await settle();
  const thumb = host.querySelector("[data-media-thumb]")!;
  const bubble = () => host.querySelector("[data-media-bubble]");
  expect(bubble()?.hasAttribute("data-shown") ?? false).toBe(false);
  await pointer(thumb, "pointerdown", 0);
  await pointer(thumb, "pointermove", 300);
  expect(scroller().scrollTop).toBeGreaterThan(40_000);
  expect(bubble()?.hasAttribute("data-shown")).toBe(true);
  expect(bubble()?.textContent).toMatch(/^\w+ 20(25|26)$/);
  expect(bubble()?.textContent).not.toBe("November 2026");
  await pointer(thumb, "pointerup", 300);
  expect(bubble()?.hasAttribute("data-shown")).toBe(true);
  await act(() => new Promise((resolve) => setTimeout(resolve, 650)));
  expect(bubble()?.hasAttribute("data-shown")).toBe(false);
});

const GRAB = 44;
const ruleOf = (css: string, selector: string) => css.match(new RegExp(`\\n\\s*${selector.replace(/[.:]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
const px = (rule: string, prop: string) => Number(new RegExp(`(?:^|[ ;])${prop}: (\\d+)px`).exec(rule)?.[1] ?? 0);

it("keeps the scroll thumb a grabbable height on a long chat, and none on a short one", async () => {
  media.t1 = shots(2_000);
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [] });
  await settle();
  expect(parseFloat(host.querySelector<HTMLElement>("[data-media-thumb]")!.style.height)).toBeGreaterThanOrEqual(GRAB);
  media.t1 = shots(4);
  forgetMedia();
  await act(async () => closeShow());
  await act(async () => showMedia("t1"));
  await settle();
  expect(host.querySelector("[data-media-thumb]")).toBeNull();
});

it("drags the scroll thumb to both ends of a long chat", async () => {
  media.t1 = shots(2_000);
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [] });
  await settle();
  const thumb = host.querySelector("[data-media-thumb]")!;
  await pointer(thumb, "pointerdown", 0);
  await pointer(thumb, "pointermove", 100_000);
  const bottom = scroller().scrollTop;
  expect(bottom).toBeGreaterThan(40_000);
  await pointer(thumb, "pointermove", -100_000);
  expect(scroller().scrollTop).toBe(0);
  await pointer(thumb, "pointerup", -100_000);
});

it("sizes the scroll thumb to grab: 44px to catch on a phone, a wider bar on a desktop", () => {
  const css = readFileSync("src/components/ShowPane.css", "utf8");
  const bar = px(ruleOf(css, ".show-media-thumb::before"), "width");
  const desktop = px(ruleOf(css, ".show-media-rail"), "width");
  const phone = px(/max-width: 767px\) \{[\s\S]*?\.show-media-rail \{([^}]*)\}/.exec(css)?.[1] ?? "", "width");
  expect(bar).toBeGreaterThanOrEqual(8);
  expect(desktop).toBeGreaterThanOrEqual(bar);
  expect(phone).toBeGreaterThanOrEqual(GRAB);
});

it("closing with the pane toggle neither asks again nor touches the grid", async () => {
  media.t1 = shots(200);
  await act(async () => showMedia("t1"));
  await act(async () => root.render(createElement(Presence, { source: { threadId: "t1", messages: [] } })));
  await settle();
  const grid = host.querySelector("[data-media-grid]")!;
  const img = grid.querySelector("img");
  const asked = calls.length;
  const renders = vi.mocked(useThumb).mock.calls.length;
  const changes: MutationRecord[] = [];
  const watch = new MutationObserver((records) => changes.push(...records));
  watch.observe(grid, { subtree: true, childList: true, attributes: true, characterData: true });
  await click(host.querySelector(".show-pane-head [data-show-pane-button]"));
  expect(host.querySelector("[data-closing]")).not.toBeNull();
  expect(host.querySelector("[data-media-grid] img")).toBe(img);
  await new Promise((resolve) => setTimeout(resolve, 0));
  watch.disconnect();
  expect(changes).toEqual([]);
  expect(vi.mocked(useThumb).mock.calls.length).toBe(renders);
  expect(calls.length).toBe(asked);
});

it("lists a room again only when a new message brings files", async () => {
  const text: Message = { id: "m1", role: "user", kind: "text", at: 1, text: "hi" };
  const sent: Message = { ...text, id: "m2", roomFiles: [{ id: id(4), name: "new.png", type: "image/png", bytes: 1 }] };
  await act(async () => showMedia("r-thread"));
  await render({ threadId: "r-thread", roomId: "r1", messages: [] });
  await settle();
  await render({ threadId: "r-thread", roomId: "r1", messages: [text] });
  await settle();
  expect(calls.filter((url) => url.endsWith("/files"))).toHaveLength(1);
  await render({ threadId: "r-thread", roomId: "r1", messages: [text, sent] });
  await settle();
  expect(calls.filter((url) => url.endsWith("/files"))).toHaveLength(2);
});

it("keeps a room's open picture open when someone posts a file", async () => {
  const sent: Message = { id: "m2", role: "user", kind: "text", at: 4, text: "", roomFiles: [{ id: id(4), name: "new.pdf", type: "application/pdf", bytes: 1 }] };
  await act(async () => showMedia("r-thread"));
  await render({ threadId: "r-thread", roomId: "r1", messages: [] });
  await settle();
  await click(host.querySelector("[data-media-grid] button"));
  expect(document.querySelector("[data-media-viewer]")).not.toBeNull();
  room = { files: [{ id: id(4), name: "new.pdf", type: "application/pdf", bytes: 1, at: 4, sender: "Mina" }, ...roomFiles] };
  await render({ threadId: "r-thread", roomId: "r1", messages: [sent] });
  await settle();
  expect(calls.filter((url) => url.endsWith("/files"))).toHaveLength(2);
  expect(document.querySelector("[data-media-viewer]")).not.toBeNull();
});

it("closes at its open width, with the same thumbs and no new fetch", async () => {
  const { showMedia } = await import("@/lib/show-pane");
  const source: MediaSource = { threadId: "r-thread", roomId: "r1", messages: [] };
  await act(async () => showMedia("r-thread"));
  await render(source);
  await settle();
  const thumb = host.querySelector("[data-media-grid] img");
  const width = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 633 } as DOMRect);
  await act(async () => root.render(createElement(Pane, { source, closing: true })));
  width.mockReturnValue({ width: 515 } as DOMRect);
  await act(async () => root.render(createElement(Pane, { source, closing: true })));
  await settle();
  width.mockRestore();
  expect(host.querySelector("aside")!.style.getPropertyValue("--dock")).toBe("633px");
  expect(host.querySelector("[data-media-grid] img")).toBe(thumb);
  expect(calls.filter((url) => url.endsWith("/files"))).toHaveLength(1);
  await render(source);
  expect(host.querySelector("aside")!.style.getPropertyValue("--dock")).toBe("");
});

it("splits Media into Photos and Files, pictures and videos in one, every other file in the other", async () => {
  const clip: Message = { id: "b2", role: "bot", kind: "text", at: 3, text: "Cut: [clip.mp4](C:\\w\\clip.mp4)" };
  await act(async () => showMedia("t1"));
  await render({ ...chat, messages: [upload, reply, clip] });
  await settle();
  expect(tab("Photos").getAttribute("aria-selected")).toBe("true");
  expect(tiles()).toEqual(["clip.mp4", "chart.png", "abc-1.png"]);
  expect(host.querySelector("[data-media-file]")).toBeNull();
  await click(tab("Files"));
  expect(names()).toEqual(["deck.pdf", "data.zip", "notes.docx"]);
  expect(host.querySelector("[data-media-grid] [data-media-key]:not([data-media-file])")).toBeNull();
  applyLocale("ko");
  await render({ ...chat, messages: [upload, reply, clip] });
  expect(tab("파일").getAttribute("aria-selected")).toBe("true");
  expect(tab("사진")).toBeDefined();
});

it("hides the switch when a chat has only one kind, and shows what it has", async () => {
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [{ ...reply, text: "[deck.pdf](C:\\w\\deck.pdf)" }] });
  await settle();
  expect(host.querySelector("[data-media-kinds]")).toBeNull();
  expect(names()).toEqual(["deck.pdf"]);
  media.t2 = shots(3);
  await act(async () => showMedia("t2"));
  await render({ threadId: "t2", messages: [] });
  await settle();
  expect(host.querySelector("[data-media-kinds]")).toBeNull();
  expect(thumbs()).toHaveLength(3);
});

it("keeps each chat's last pick for the session, and switching never asks again", async () => {
  media.t2 = wire([["m1", NOVEMBER, "l", "a.png", "C:\\w\\a.png"], ["m0", NOVEMBER, "l", "b.pdf", "C:\\w\\b.pdf"]]);
  await act(async () => showMedia("t1"));
  await render(chat);
  await settle();
  await click(tab("Files"));
  const asked = calls.length;
  await click(tab("Photos"));
  await click(tab("Files"));
  await settle();
  expect(calls.length).toBe(asked);
  await act(async () => showMedia("t2"));
  await render({ threadId: "t2", messages: [] });
  await settle();
  expect(tab("Photos").getAttribute("aria-selected")).toBe("true");
  await act(async () => showMedia("t1"));
  await render(chat);
  await settle();
  expect(tab("Files").getAttribute("aria-selected")).toBe("true");
  expect(names()).toEqual(["deck.pdf", "data.zip", "notes.docx"]);
});

it("a file row shows its kind, size and day, and in a room who sent it", async () => {
  room = { files: [{ ...roomFiles[0]!, at: NOVEMBER }, { ...roomFiles[1]!, bytes: 2_500_000, at: NOVEMBER }, { ...roomFiles[2]!, at: NOVEMBER - DAY }] };
  await act(async () => showMedia("r-thread"));
  await render({ threadId: "r-thread", roomId: "r1", messages: [] });
  await settle();
  await click(tab("Files"));
  const rows = [...host.querySelectorAll("[data-media-file]")];
  expect(rows.map((row) => row.textContent)).toEqual(["plan.pdf2.4 MB · Mina · Nov 20", "sheet.xlsx10 B · Host · Nov 19"]);
  expect(rows.map((row) => row.querySelector("svg")!.getAttribute("class"))).toEqual([expect.stringContaining("lucide-file-text"), expect.stringContaining("lucide-file-spreadsheet")]);
  act(() => root.unmount());
  root = createRoot(host);
  applyLocale("ko");
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [{ ...upload, at: NOVEMBER }] });
  await settle();
  await click(tab("파일"));
  expect(host.querySelector("[data-media-file]")!.textContent).toBe("notes.docx2.0 KB · 11월 20일");
});

it("mounts only the file rows on screen out of 5,000, with the full height known at once", async () => {
  media.t1 = wire([["p", NOVEMBER, "l", "a.png", "C:\\w\\a.png"], ...Array.from({ length: 5_000 }, (_, n): Entry => [`m${n}`, NOVEMBER - n * DAY / 2, "l", `doc-${n}.pdf`, `C:\\w\\doc-${n}.pdf`])]);
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [] });
  await settle();
  await click(tab("Files"));
  const first = names();
  expect(first[0]).toBe("doc-0.pdf");
  expect(first.length).toBeLessThan(60);
  expect(Number.parseFloat(host.querySelector<HTMLElement>("[data-media-grid]")!.style.height)).toBeGreaterThan(5_000 * 44);
  await act(async () => { scroller().scrollTop = 120_000; scroller().dispatchEvent(new Event("scroll")); });
  const later = names();
  expect(later.length).toBeLessThan(60);
  expect(Number(later[0]!.match(/doc-(\d+)/)![1])).toBeGreaterThan(2_000);
});

it("a video tile shows its first frame and plays muted only while a mouse rests on it", async () => {
  frames(true);
  await act(async () => showMedia("t1"));
  await render(clipChat("walk.mp4"));
  await settle();
  const tile = host.querySelector<HTMLElement>('[data-media-grid] [title="walk.mp4"]')!;
  expect(tile.querySelector("img")!.getAttribute("src")).toMatch(/^blob:/);
  expect(tile.textContent).toBe("walk.mp4");
  const clip = tile.firstElementChild!;
  await hover(clip, "pointerover");
  expect(tile.querySelector("video")).toBeNull();
  await wait(300);
  const video = tile.querySelector("video")!;
  expect(video.getAttribute("src")).toBe("/api/threads/t1/linked-file?path=" + encodeURIComponent("C:\\w\\walk.mp4"));
  expect(video.muted).toBe(true);
  expect(video.loop).toBe(true);
  await hover(clip, "pointerout");
  expect(tile.querySelector("video")).toBeNull();
  await hover(clip, "pointerover");
  await wait(300);
  await act(async () => { scroller().dispatchEvent(new Event("scroll")); });
  expect(tile.querySelector("video")).toBeNull();
  await hover(clip, "pointerout");
  await hover(clip, "pointerover", "touch");
  await wait(300);
  expect(tile.querySelector("video")).toBeNull();
});

it("a video tile reads its frame only once the scroll rests", async () => {
  frames(true);
  await act(async () => showMedia("t1"));
  await render(clipChat("pan.mp4"));
  await settle();
  await act(async () => { scroller().dispatchEvent(new Event("scroll")); });
  await render({ threadId: "t1", messages: [...clipChat("pan.mp4").messages, { ...clipChat("tilt.mp4").messages[0], id: "c2", at: 2 }] });
  await settle();
  const tile = host.querySelector<HTMLElement>('[data-media-grid] [title="tilt.mp4"]')!;
  expect(tile.querySelector("img")).toBeNull();
  await wait(250);
  expect(tile.querySelector("img")!.getAttribute("src")).toMatch(/^blob:/);
});

it("a hover preview keeps its source when StrictMode runs its ref twice", async () => {
  frames(true);
  await act(async () => showMedia("t1"));
  await act(async () => root.render(createElement(StrictMode, null, createElement(Pane, { source: clipChat("loop.mp4") }))));
  await settle();
  const tile = host.querySelector<HTMLElement>('[data-media-grid] [title="loop.mp4"]')!;
  await hover(tile.firstElementChild!, "pointerover");
  await wait(300);
  expect(tile.querySelector("video")!.getAttribute("src")).toBe("/api/threads/t1/linked-file?path=" + encodeURIComponent("C:\\w\\loop.mp4"));
});

it("a room video keeps its play icon and name, and a tap downloads it, since a room sends its files whole", async () => {
  frames(true);
  room = { files: [{ id: id(4), name: "walk.mp4", type: "video/mp4", bytes: 10, at: 4, sender: "Mina" }] };
  await render({ threadId: "r-thread", roomId: "r1", messages: [] });
  const { togglePane } = await import("@/lib/show-pane");
  await act(async () => togglePane("r-thread"));
  await click(tab("Media"));
  await settle();
  const tile = host.querySelector<HTMLElement>('[data-media-grid] [title="walk.mp4"]')!;
  expect(tile.querySelector("img")).toBeNull();
  expect(tile.querySelector(".truncate")!.textContent).toBe("walk.mp4");
  const saved = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await click(tile);
  expect((saved.mock.contexts as HTMLAnchorElement[]).map((link) => [link.getAttribute("href"), link.download])).toEqual([[`/api/rooms/r1/files/${id(4)}`, "walk.mp4"]]);
  expect(document.querySelector("[data-media-viewer]")).toBeNull();
});

it("a video whose frame can't be read keeps its play icon and name", async () => {
  frames(false);
  await act(async () => showMedia("t1"));
  await render(clipChat("broken.mov"));
  await settle();
  const tile = host.querySelector<HTMLElement>('[data-media-grid] [title="broken.mov"]')!;
  expect(tile.querySelector("img")).toBeNull();
  expect(tile.querySelector(".lucide-play")).not.toBeNull();
  expect(tile.querySelector(".truncate")!.textContent).toBe("broken.mov");
});

it("a tap on a video tile plays it in the viewer, between its neighbours, with no download", async () => {
  frames(true);
  const bot = (n: number, name: string): Message => ({ id: "m" + n, role: "bot", kind: "text", at: n, text: `[${name}](C:\\w\\${name})` });
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: [bot(1, "a.png"), bot(2, "walk.mp4"), bot(3, "c.png")] });
  await settle();
  expect(host.querySelector("[data-media-grid] a[download]")).toBeNull();
  await click(host.querySelector('[data-media-grid] [title="walk.mp4"]'));
  expect(host.querySelector("[data-media-grid] a[download]")).toBeNull();
  const video = () => document.querySelector("[data-media-viewer] video");
  expect(video()!.getAttribute("src")).toBe(linked("C:\\w\\walk.mp4"));
  await key("ArrowRight");
  expect(video()).toBeNull();
  expect(viewed()).toBe(linked("C:\\w\\a.png"));
  await key("ArrowLeft");
  await key("ArrowLeft");
  expect(viewed()).toBe(linked("C:\\w\\c.png"));
});

const mock = String.raw`C:\cards\forum-look-mock-2`;
const listing = {
  files: [
    ...["icon-31-wink.png", "icon-25-pixel-bot.png", "icon-22-radar-rings.png"].map((name, n) => ({ name, path: `${mock}\\${name}`, size: 10, modified: NOVEMBER - n })),
    { name: "forum-look-mock-2.html", path: `${mock}\\forum-look-mock-2.html`, size: 21_525, modified: NOVEMBER - 10 },
    { name: "notes.txt", path: `${mock}\\notes.txt`, size: 8, modified: NOVEMBER - 11 },
  ],
  more: 2,
};
const folderFetch = (answer: FolderListing | null) => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
  calls.push(url);
  if (url.includes("/linked-folder?")) return answer ? Response.json(answer) : Response.json({ error: "not found" }, { status: 404 });
  return new Response(null, { status: 206 });
}));
const linked = (path: string) => `/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`;
const viewed = () => document.querySelector("[data-media-viewer] img")?.getAttribute("src");
const key = (name: string) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });

it("a linked folder shows in Show, and its pictures step with the arrow keys", async () => {
  folderFetch(listing);
  await act(async () => showItem({ threadId: "t1", path: mock, kind: "folder" }));
  await render(chat);
  await settle();
  expect(tab("Show").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector(".show-frame-name")?.textContent).toBe("forum-look-mock-2");
  expect(calls).toContain(`/api/threads/t1/linked-folder?path=${encodeURIComponent(mock)}`);
  expect(tiles()).toEqual(["icon-31-wink.png", "icon-25-pixel-bot.png", "icon-22-radar-rings.png"]);
  await click(host.querySelector('[data-media-grid] [title="icon-31-wink.png"]'));
  expect(viewed()).toBe(linked(listing.files[0]!.path));
  await key("ArrowRight");
  expect(viewed()).toBe(linked(listing.files[1]!.path));
  await key("ArrowRight");
  expect(viewed()).toBe(linked(listing.files[2]!.path));
  await key("ArrowRight");
  expect(viewed()).toBe(linked(listing.files[2]!.path));
  await key("ArrowLeft");
  expect(viewed()).toBe(linked(listing.files[1]!.path));
});

it("a linked folder's page and text show in Show, and it says how many more", async () => {
  folderFetch(listing);
  await act(async () => showItem({ threadId: "t1", path: mock, kind: "folder" }));
  await render(chat);
  await settle();
  await click(tab("Files"));
  expect(names()).toEqual(["forum-look-mock-2.html", "notes.txt"]);
  expect(host.querySelector("[data-folder-more]")?.textContent).toBe("2 more files");
  await click(row("forum-look-mock-2.html"));
  await settle();
  expect(shown).toEqual({ threadId: "t1", path: listing.files[3]!.path, kind: "page" });
  expect(host.querySelector('.show-frame[data-kind="page"] .show-frame-name')?.textContent).toBe("forum-look-mock-2.html");
  await act(async () => showItem({ threadId: "t1", path: mock, kind: "folder" }));
  await settle();
  await click(row("notes.txt"));
  await settle();
  expect(shown).toEqual({ threadId: "t1", path: listing.files[4]!.path, kind: "text" });
});

it("a folder its link just listed draws without asking again, and says so when it can't list", async () => {
  folderFetch(listing);
  await act(async () => showFolder("t1", `${mock}-new`, listing));
  await render(chat);
  await settle();
  expect(tiles()).toHaveLength(3);
  expect(calls.filter((url) => url.includes("/linked-folder?"))).toEqual([]);
  act(() => closeShow());
  folderFetch(null);
  applyLocale("ko");
  await act(async () => showItem({ threadId: "t1", path: `${mock}-gone`, kind: "folder" }));
  await settle();
  expect(host.querySelector('[data-kind="folder"] [role="status"]')?.textContent).toBe("이 폴더를 열 수 없어요");
});

it("an empty linked folder says so in Korean", async () => {
  folderFetch({ files: [], more: 0 });
  applyLocale("ko");
  await act(async () => showItem({ threadId: "t1", path: mock, kind: "folder" }));
  await render(chat);
  await settle();
  expect(host.querySelector(".show-media-empty")?.textContent).toBe("이 폴더에는 파일이 없어요");
});

it("clicking an open folder's link again draws the fresh listing, even behind another tab", async () => {
  folderFetch(listing);
  const folder = `${mock}-again`;
  const added = { ...listing, files: [{ name: "icon-37-job-code.png", path: `${folder}/icon-37-job-code.png`, size: 10, modified: NOVEMBER + 1 }, ...listing.files] };
  await act(async () => showFolder("t1", folder, listing));
  await render(chat);
  await settle();
  expect(tiles()).toHaveLength(3);
  await act(async () => showFolder("t1", folder, added));
  await settle();
  expect(tiles()).toEqual(["icon-37-job-code.png", ...listing.files.slice(0, 3).map((file) => file.name)]);
  await click(tab("Media"));
  await act(async () => showFolder("t1", folder, listing));
  await settle();
  expect(tab("Show").getAttribute("aria-selected")).toBe("true");
  expect(tiles()).toHaveLength(3);
  expect(calls.filter((url) => url.includes("/linked-folder?"))).toEqual([]);
});
