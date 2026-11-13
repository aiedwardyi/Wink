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
afterEach(() => { act(() => root.unmount()); host.remove(); act(() => closeShow()); applyLocale("en"); forgetMedia(); delete window.ogb; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  expect(items()).toEqual(["Copy image", "Save as", "Delete"]);
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

it("a group picture opens the shared menu instead of the browser menu", async () => {
  await open({ threadId: "group-thread", messages: [{ id: "p1", role: "bot", kind: "text", at: 1, text: "[chart.png](C:\\w\\chart.png)" }] });
  expect(rightClick(host.querySelector("[data-media-grid] img")!).defaultPrevented).toBe(true);
  await settle();
  expect(items()).toEqual(["Copy image", "Save as"]);
});

it("Delete uses the same hover and keyboard focus surface as other items", async () => {
  await open(roomSource);
  rightClick(host.querySelector("[data-media-grid] button")!);
  await settle();
  expect(item("Delete").className).toContain("hover:bg-control");
  expect(item("Delete").className).toContain("focus-visible:bg-control");
  expect(item("Delete").className).toContain("text-danger");
  expect(document.querySelector('[role="separator"]')).not.toBeNull();
});

it("a desktop picture offers Show in folder for its existing local file", async () => {
  const localMediaFile = vi.fn(async () => "C:\\w\\chart.png");
  const showInFolder = vi.fn(async () => {});
  window.ogb = { localMediaFile, showInFolder } as unknown as typeof window.ogb;
  try {
    await open({ threadId: "t1", messages: [{ id: "p1", role: "bot", kind: "text", at: 1, text: "[chart.png](C:\\w\\chart.png)" }] });
    rightClick(host.querySelector("[data-media-grid] button")!);
    await settle();
    expect(items()).toEqual(["Copy image", "Save as", "Show in folder"]);
    await act(async () => item("Show in folder").click());
    expect(showInFolder).toHaveBeenCalledWith("C:\\w\\chart.png");
  } finally { delete window.ogb; }
});

it("doesn't offer Show in folder for a missing desktop picture", async () => {
  window.ogb = { localMediaFile: async () => null, showInFolder: vi.fn() } as unknown as typeof window.ogb;
  await open({ threadId: "t1", messages: [{ id: "p1", role: "bot", kind: "text", at: 1, text: "[gone.png](C:\\w\\gone.png)" }] });
  rightClick(host.querySelector("[data-media-grid] button")!);
  await settle();
  expect(items()).toEqual(["Copy image", "Save as"]);
});

it("keyboard arrows focus Delete on the shared surface", async () => {
  await open(roomSource);
  rightClick(host.querySelector("[data-media-grid] button")!);
  await settle();
  expect(document.activeElement).toBe(item("Copy image"));
  await act(async () => { item("Copy image").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(item("Delete"));
  await act(async () => { item("Delete").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(item("Copy image"));
});

it("Copy image writes PNG bytes and closes its menu", async () => {
  const write = vi.fn(async () => {});
  const copied: Array<Record<string, Promise<Blob>>> = [];
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal("ClipboardItem", class { constructor(data: Record<string, Promise<Blob>>) { copied.push(data); } });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith("/preview") ? Promise.resolve(new Response("png", { headers: { "content-type": "image/png" } })) : original(input, init));
  await open(roomSource);
  rightClick(host.querySelector("[data-media-grid] button")!);
  await settle();
  await act(async () => item("Copy image").click());
  expect(write).toHaveBeenCalledOnce();
  expect((await copied[0]!["image/png"]!).type).toBe("image/png");
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("keeps the menu retryable when clipboard access fails", async () => {
  vi.stubGlobal("navigator", { clipboard: { write: vi.fn(async () => { throw new Error("denied"); }) } });
  vi.stubGlobal("ClipboardItem", class {});
  await open(roomSource);
  rightClick(host.querySelector("[data-media-grid] button")!);
  await settle();
  await act(async () => item("Copy image").click());
  await settle();
  expect(document.querySelector('[role="menu"] [role="alert"]')?.textContent).toContain("Couldn't copy");
  expect(items()).toEqual(["Copy image", "Save as", "Delete"]);
});

it("doesn't let a late desktop lookup reveal a previously opened tile", async () => {
  let resolve!: (path: string) => void;
  const localMediaFile = vi.fn().mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; })).mockResolvedValueOnce("C:\\w\\plan.pdf");
  window.ogb = { localMediaFile, showInFolder: vi.fn() } as unknown as typeof window.ogb;
  await open(roomSource);
  rightClick(host.querySelector("[data-media-grid] button")!);
  await settle();
  await filesTab();
  rightClick(fileRow("plan.pdf"));
  await act(async () => resolve("C:\\w\\photo.png"));
  await settle();
  expect(items()).toEqual(["Save as", "Show in folder", "Delete"]);
  await act(async () => item("Show in folder").click());
  expect(window.ogb!.showInFolder).toHaveBeenCalledWith("C:\\w\\plan.pdf");
});

it("a read-only room folder shows its notice on top and hides Delete", async () => {
  room.error = "unavailable";
  await open(roomSource);
  const media = host.querySelector("[data-show-media]")!;
  expect(media.firstElementChild!.getAttribute("role")).toBe("alert");
  expect(media.firstElementChild!.textContent).toContain("read-only");
  await filesTab();
  rightClick(fileRow("plan.pdf"));
  await settle();
  expect(items()).toEqual(["Save as"]);
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
  expect(items()).toEqual(["Copy image", "Save as", "Delete"]);
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

it("Save as keeps a room file's name when its desktop blob has an opaque ID", async () => {
  const saveFile = vi.fn(async () => {});
  window.ogb = { saveFile, localMediaFile: async () => `C:\\room-files\\${plan.id}` } as unknown as typeof window.ogb;
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await open(roomSource);
  await filesTab();
  rightClick(fileRow("plan.pdf"));
  await settle();
  await act(async () => item("Save as").click());
  expect(saveFile).not.toHaveBeenCalled();
  expect((download.mock.contexts[0] as HTMLAnchorElement).download).toBe("plan.pdf");
});

it("Escape closes a file's menu and leaves the pane open", async () => {
  await open(roomSource);
  await filesTab();
  rightClick(fileRow("plan.pdf"));
  await settle();
  await act(async () => { item("Save as").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(host.querySelector("[data-show-media]")).not.toBeNull();
});

it("a bot chat's files and pictures share the desktop menu", async () => {
  const saveFile = vi.fn(async () => {});
  const showInFolder = vi.fn(async () => {});
  window.ogb = { saveFile, showInFolder, localMediaFile: async ({ path }: { path?: string }) => path ?? null } as unknown as typeof window.ogb;
  const reply = { id: "b1", role: "bot" as const, kind: "text" as const, at: 2, text: "Here: [deck.pdf](C:\\w\\deck.pdf) and [chart.png](C:\\w\\chart.png)" };
  await open({ threadId: "t1", messages: [reply] });
  expect(rightClick(host.querySelector("[data-media-grid] button")!).defaultPrevented).toBe(true);
  await settle();
  expect(items()).toEqual(["Copy image", "Save as", "Show in folder"]);
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
  expect(rightClick(fileRow("notes.docx")).defaultPrevented).toBe(true);
  await settle();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
