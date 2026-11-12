// @vitest-environment happy-dom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { closeShow, showItem, useMediaThread, useShowItem, type ShowItem } from "@/lib/show-pane";
import type { MediaSource } from "@/lib/show-media";
import type { Message } from "@/state/store";
import { ShowPane } from "./ShowPane";

vi.mock("./ShowPdf", () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const upload: Message = { id: "u1", role: "user", kind: "text", at: 1, text: 'see\n<attached-image path="C:\\att\\abc-1.png" />\n<attached-file path="C:\\att\\notes.docx" name="notes.docx" size="2048" />' };
const reply: Message = { id: "b1", role: "bot", kind: "text", at: 2, text: "Here: [chart.png](C:\\w\\chart.png), [deck.pdf](C:\\w\\deck.pdf), [data.zip](C:\\w\\data.zip)" };
const older: Message = { id: "b0", role: "bot", kind: "text", at: 0, text: "Old: [first.pdf](C:\\w\\first.pdf)" };
const id = (n: number) => String(n).padStart(24, "f");
const roomFiles = [
  { id: id(3), name: "photo.png", type: "image/png", bytes: 10, at: 3, sender: "Mina" },
  { id: id(2), name: "plan.pdf", type: "application/pdf", bytes: 10, at: 2, sender: "Mina" },
  { id: id(1), name: "sheet.xlsx", type: "application/octet-stream", bytes: 10, at: 1, sender: "Host" },
];

let root: Root;
let host: HTMLElement;
let shown: ShowItem | null = null;
let calls: string[] = [];
let room: { files: unknown[] } = { files: roomFiles };

beforeEach(() => {
  calls = [];
  room = { files: roomFiles };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("/messages?")) return Response.json({ messages: [older], hasMore: false });
    if (url.endsWith("/files")) return Response.json({ ...room, used: 0, capacity: 1, error: null });
    return new Response(null, { status: 206 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); act(() => closeShow()); applyLocale("en"); delete window.ogb; vi.unstubAllGlobals(); });

function Pane({ source }: { source: MediaSource }) {
  const item = useShowItem();
  const media = useMediaThread() === source.threadId;
  shown = item;
  return item || media ? createElement(ShowPane, { item: item ?? undefined, media, source, hidden: false }) : null;
}

const render = (source: MediaSource) => act(async () => root.render(createElement(Pane, { source })));
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((each) => each.textContent === name)!;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());
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

it("lists a chat's images and files newest first", async () => {
  await act(async () => showItem(deck));
  await render(chat);
  await click(tab("Media"));
  await settle();
  expect([...host.querySelectorAll("[data-media-grid] img")].map((img) => img.getAttribute("src"))).toEqual([
    "/api/threads/t1/linked-file?path=" + encodeURIComponent("C:\\w\\chart.png"),
    "/api/attachments/abc-1.png",
  ]);
  expect([...host.querySelectorAll("[data-media-file]")].map((row) => row.textContent)).toEqual(["deck.pdf", "data.zip", "notes.docx"]);
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
  await click([...host.querySelectorAll("[data-media-file]")].find((row) => row.textContent === "data.zip")!);
  expect(openFile).toHaveBeenCalledWith("C:\\w\\data.zip");
  await click([...host.querySelectorAll("[data-media-file]")].find((row) => row.textContent === "deck.pdf")!);
  expect(tab("Show").getAttribute("aria-selected")).toBe("true");
  expect(shown).toEqual(deck);
});

it("loads older pages only once Media opens", async () => {
  await act(async () => showItem(deck));
  await render({ ...chat, hasMore: true });
  await settle();
  expect(calls.filter((url) => url.includes("/messages?"))).toEqual([]);
  await click(tab("Media"));
  await settle();
  expect(calls.filter((url) => url.includes("/messages?"))).toEqual(["/api/threads/t1/messages?limit=200&before=u1&pages=5"]);
  expect([...host.querySelectorAll("[data-media-file]")].map((row) => row.textContent).at(-1)).toBe("first.pdf");
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
  const sheet = [...host.querySelectorAll("[data-media-file]")].find((row) => row.textContent === "sheet.xlsx")!;
  expect(sheet.getAttribute("href")).toBe(`/api/rooms/r1/files/${id(1)}`);
  expect(sheet.hasAttribute("download")).toBe(true);
  await click([...host.querySelectorAll("[data-media-file]")].find((row) => row.textContent === "plan.pdf")!);
  expect(shown).toEqual({ threadId: "r-thread", path: "plan.pdf", kind: "pdf", src: `/api/rooms/r1/files/${id(2)}` });
});

it("says so when there are no files yet, in English and Korean", async () => {
  room = { files: [] };
  const { showMedia } = await import("@/lib/show-pane");
  await act(async () => showMedia("t9"));
  await render({ threadId: "t9", messages: [] });
  await settle();
  expect(host.querySelector("[data-show-media]")?.textContent).toBe("No files yet");
  expect(tab("Show").disabled).toBe(true);
  applyLocale("ko");
  await render({ threadId: "t9", roomId: "r1", messages: [] });
  await settle();
  expect(host.querySelector("[data-show-media]")?.textContent).toBe("아직 파일이 없어요");
  expect(tab("미디어")).toBeDefined();
});

it("keeps 300 files in a scrolling list with lazy thumbs", async () => {
  const many = Array.from({ length: 300 }, (_, n): Message => ({ id: `m${n}`, role: "bot", kind: "text", at: n, text: `[shot-${n}.png](C:\\w\\shot-${n}.png)` }));
  const { showMedia } = await import("@/lib/show-pane");
  await act(async () => showMedia("t1"));
  await render({ threadId: "t1", messages: many });
  await settle();
  const thumbs = host.querySelectorAll("[data-media-grid] img");
  expect(thumbs).toHaveLength(300);
  expect([...thumbs].every((img) => img.getAttribute("loading") === "lazy")).toBe(true);
  expect(thumbs[0]!.getAttribute("src")).toContain("shot-299.png");
  expect(readFileSync("src/components/ShowPane.css", "utf8")).toMatch(/\.show-media \{[^}]*overflow-y: auto/);
});

it("lists a room again only when a new message brings files", async () => {
  const { showMedia } = await import("@/lib/show-pane");
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
