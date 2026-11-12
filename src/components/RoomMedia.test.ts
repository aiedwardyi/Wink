// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { forgetMedia } from "@/lib/media-index";
import { closeShow, showMedia, useMediaThread } from "@/lib/show-pane";
import type { MediaSource } from "@/lib/show-media";
import { ShowPane } from "./ShowPane";

vi.mock("./ShowPdf", () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (n: number) => String(n).padStart(24, "f");
const photo = { id: id(3), name: "photo.png", type: "image/png", bytes: 10, at: 3, sender: "Mina" };
const plan = { id: id(2), name: "plan.pdf", type: "application/pdf", bytes: 10, at: 2, sender: "Mina" };

let root: Root;
let host: HTMLElement;
let calls: string[];
let room: { files: unknown[]; used: number; capacity: number; error: string | null };

beforeEach(() => {
  calls = [];
  room = { files: [photo, plan], used: 18_000, capacity: 100 * 1024 ** 3, error: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "DELETE") {
      room = { ...room, files: room.files.filter((file) => !url.endsWith((file as { id: string }).id)) };
      return Response.json({ ok: true });
    }
    if (url.endsWith("/files")) return Response.json(room);
    if (url.endsWith("/media")) return Response.json({ v: "1", ids: [], at: [], kind: "", name: [], ref: [], size: [] });
    return new Response(null, { status: 206 });
  }));
  // happy-dom has no layout, and Media draws only the cells that fit its measured pane
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("show-media-scroll") ? 412 : 0; });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("show-media-scroll") ? 600 : 0; });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); act(() => closeShow()); applyLocale("en"); forgetMedia(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Pane({ source }: { source: MediaSource }) {
  return useMediaThread() === source.threadId ? createElement(ShowPane, { media: true, source, hidden: false }) : null;
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const open = async (source: MediaSource) => {
  await act(async () => showMedia(source.threadId));
  await act(async () => root.render(createElement(Pane, { source })));
  await settle();
};
const roomSource: MediaSource = { threadId: "r-thread", roomId: "r1", messages: [] };
const rightClick = (el: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  act(() => { el.dispatchEvent(event); });
  return event;
};
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].map((item) => item.textContent);
const item = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find((each) => each.textContent === name)!;
const filesTab = () => act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((each) => each.textContent === "Files")!.click());
const fileRow = (name: string) => [...host.querySelectorAll("[data-media-file]")].find((row) => row.querySelector("span span")!.textContent === name)!;
const confirmButton = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-modal="true"] button')].find((button) => button.textContent === "Delete")!;

it("right-click on a room file deletes it after the same confirm, and Media lists again", async () => {
  await open(roomSource);
  await filesTab();
  const row = fileRow("plan.pdf");
  row.setAttribute("title", "");
  expect(rightClick(row).defaultPrevented).toBe(true);
  await settle();
  expect(item("Delete").disabled).toBe(false);
  await act(async () => item("Delete").click());
  expect(document.body.textContent).toContain("Delete this file for everyone?");
  expect(document.body.textContent).toContain("plan.pdf");
  await act(async () => confirmButton().click());
  await settle();
  expect(calls).toContain(`DELETE /api/rooms/r1/files/${plan.id}`);
  expect(host.querySelector("[data-media-kinds]")).toBeNull();
  expect(host.querySelectorAll("[data-media-file]")).toHaveLength(0);
  expect(host.querySelectorAll("[data-media-grid] button")).toHaveLength(1);
});

it("a hold on a room picture opens the menu, and the lift does not open the picture", async () => {
  await open(roomSource);
  const tile = host.querySelector("[data-media-grid] button")!;
  tile.setAttribute("title", "");
  const touch = { clientX: 30, clientY: 30, identifier: 1, target: tile };
  act(() => { tile.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch] as unknown as Touch[] })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  await settle();
  expect(items()).toEqual(["Delete"]);
  const lift = new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [] });
  act(() => { tile.dispatchEvent(lift); });
  expect(lift.defaultPrevented).toBe(true);
  expect(document.querySelector("[data-media-viewer]")).toBeNull();
});

it("a room's Media ends with the space used", async () => {
  await open(roomSource);
  const media = host.querySelector("[data-show-media]")!;
  expect(media.lastElementChild!.textContent).toBe("17.6 KB used / 100 GB");
  expect(media.querySelector('[role="alert"]')).toBeNull();
});

it("a read-only room folder shows its notice on top and can't delete", async () => {
  room.error = "unavailable";
  await open(roomSource);
  const media = host.querySelector("[data-show-media]")!;
  expect(media.firstElementChild!.getAttribute("role")).toBe("alert");
  expect(media.firstElementChild!.textContent).toContain("read-only");
  await filesTab();
  rightClick(fileRow("plan.pdf"));
  await settle();
  expect(item("Delete").disabled).toBe(true);
});

it("Delete on a tile far down a long grid removes exactly that file", async () => {
  const shots = Array.from({ length: 300 }, (_, n) => ({ id: id(100 + n), name: `shot-${n}.png`, type: "image/png", bytes: 10, at: 300 - n, sender: "Mina" }));
  room.files = shots;
  await open(roomSource);
  const scroller = host.querySelector<HTMLElement>(".show-media-scroll")!;
  await act(async () => { scroller.scrollTop = 12_000; scroller.dispatchEvent(new Event("scroll")); });
  await settle();
  const key = [...host.querySelectorAll<HTMLElement>("[data-media-grid] [data-media-key]")].at(-1)!.dataset.mediaKey!;
  expect(shots.findIndex((shot) => shot.id === key)).toBeGreaterThan(250);
  rightClick(host.querySelector(`[data-media-key="${key}"]`)!);
  await settle();
  expect(items()).toEqual(["Delete"]);
  await act(async () => item("Delete").click());
  await act(async () => confirmButton().click());
  await settle();
  expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([`DELETE /api/rooms/r1/files/${key}`]);
  expect(host.querySelector(`[data-media-key="${key}"]`)).toBeNull();
});

it("a room file offers Save as and Delete, and Save as downloads it", async () => {
  const save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await open(roomSource);
  await filesTab();
  expect(rightClick(fileRow("plan.pdf")).defaultPrevented).toBe(true);
  await settle();
  expect(items()).toEqual(["Save as", "Delete"]);
  await act(async () => item("Save as").click());
  expect(save).toHaveBeenCalledTimes(1);
  expect((save.mock.contexts[0] as HTMLAnchorElement).getAttribute("href")).toBe(`/api/rooms/r1/files/${plan.id}`);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("a bot chat's file offers Save as and Show in folder on the desktop, and its pictures keep the native menu", async () => {
  const saveFile = vi.fn(async () => {});
  const showInFolder = vi.fn(async () => {});
  window.ogb = { saveFile, showInFolder } as unknown as typeof window.ogb;
  const reply = { id: "b1", role: "bot" as const, kind: "text" as const, at: 2, text: "Here: [deck.pdf](C:\\w\\deck.pdf) and [chart.png](C:\\w\\chart.png)" };
  await open({ threadId: "t1", messages: [reply] });
  expect(rightClick(host.querySelector("[data-media-grid] button")!).defaultPrevented).toBe(false);
  await filesTab();
  rightClick(fileRow("deck.pdf"));
  await settle();
  expect(items()).toEqual(["Save as", "Show in folder"]);
  await act(async () => item("Show in folder").click());
  expect(showInFolder).toHaveBeenCalledWith("C:\\w\\deck.pdf");
  rightClick(fileRow("deck.pdf"));
  await settle();
  await act(async () => item("Save as").click());
  expect(saveFile).toHaveBeenCalledWith("C:\\w\\deck.pdf");
  expect(host.querySelector("[data-show-media]")!.textContent).not.toContain("used /");
  delete window.ogb;
});

it("on a phone a file it can fetch offers Save as alone, and one only its PC holds has no menu", async () => {
  const upload = { id: "u1", role: "user" as const, kind: "text" as const, at: 1, text: '<attached-file path="C:\\att\\notes.docx" name="notes.docx" size="2048" />' };
  const reply = { id: "b1", role: "bot" as const, kind: "text" as const, at: 2, text: "Here: [deck.pdf](C:\\w\\deck.pdf)" };
  await open({ threadId: "t1", messages: [upload, reply] });
  rightClick(fileRow("deck.pdf"));
  await settle();
  expect(items()).toEqual(["Save as"]);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(rightClick(fileRow("notes.docx")).defaultPrevented).toBe(false);
  await settle();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
