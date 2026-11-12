// @vitest-environment happy-dom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { forgetMedia, type MediaWire } from "@/lib/media-index";
import { useThumb } from "@/lib/media-thumbs";
import { closeShow, showItem, showMedia, useMediaThread, useShowItem, type ShowItem } from "@/lib/show-pane";
import type { MediaSource } from "@/lib/show-media";
import { usePresence } from "@/lib/use-presence";
import type { Message } from "@/state/store";
import { ShowPane } from "./ShowPane";

vi.mock("./ShowPdf", () => ({ default: () => null }));
// every cell asks for its thumb on each render, so the calls count the grid's renders
vi.mock("@/lib/media-thumbs", async (load) => {
  const real = await load<typeof import("@/lib/media-thumbs")>();
  return { useThumb: vi.fn((src: string) => real.useThumb(src)) };
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
    const asked = url.match(/^\/api\/threads\/([^/?]+)\/media(?:\?v=(.+))?$/);
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
const scroller = () => host.querySelector<HTMLElement>(".show-media-scroll")!;
const pointer = (el: Element, type: string, clientY: number) => act(async () => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientY })); });
const chat: MediaSource = { threadId: "t1", messages: [upload, reply] };
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

it("asks for the whole timeline only once Media opens, then for its version alone", async () => {
  media.t1 = wire([["b0", 0, "l", "first.pdf", "C:\\w\\first.pdf"]]);
  await act(async () => showItem(deck));
  await render({ ...chat, hasMore: true });
  await settle();
  expect(calls).toEqual([]);
  await click(tab("Media"));
  await settle();
  expect(calls).toEqual(["/api/threads/t1/media"]);
  await click(tab("Files"));
  expect(names().at(-1)).toBe("first.pdf");
  await click(tab("Show"));
  await click(tab("Media"));
  await settle();
  expect(calls).toEqual(["/api/threads/t1/media", "/api/threads/t1/media?v=1"]);
  expect(names().at(-1)).toBe("first.pdf");
});

// `older` messages before the loaded page, paged or indexed; only the very first brings a file
function longChat(older: number, fail = 0) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (fail-- > 0) return new Response(null, { status: 503 });
    if (url.includes("/media")) return Response.json(wire([["h0", 0, "l", "first.pdf", "C:\\w\\first.pdf"]]));
    const before = new URL(url, "http://x").searchParams.get("before")!;
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
  expect(calls.filter((url) => url.includes("/media"))).toHaveLength(2);
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
  expect(sheet.getAttribute("href")).toBe(`/api/rooms/r1/files/${id(1)}`);
  expect(sheet.hasAttribute("download")).toBe(true);
  await click(row("plan.pdf"));
  expect(shown).toEqual({ threadId: "r-thread", path: "plan.pdf", kind: "pdf", src: `/api/rooms/r1/files/${id(2)}` });
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

it("closing with X neither asks again nor touches the grid", async () => {
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
  await click(host.querySelector('button[aria-label="Close"]'));
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
