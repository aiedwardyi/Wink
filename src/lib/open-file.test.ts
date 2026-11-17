// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { fileOpen, openFile, paneKind, saveFile } from "./open-file";
import { closeShow, lastShown, linkedFileSrc } from "./show-pane";

const W = "C:\\w\\";
let saved: HTMLAnchorElement[] = [];

beforeEach(() => {
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this); });
});
afterEach(() => {
  closeShow();
  Reflect.deleteProperty(window, "ogb");
  vi.restoreAllMocks();
});

it.each([
  ["a.png", "picture"], ["B.JPG", "picture"], ["c.webp", "picture"],
  ["clip.mp4", "video"], ["clip.MOV", "video"], ["clip.webm", "video"],
  ["song.mp3", "audio"], ["memo.m4a", "audio"], ["take.wav", "audio"],
  ["deck.pdf", "pdf"],
  ["notes.txt", "text"], ["README.md", "text"], ["data.csv", "text"], ["data.json", "text"], ["run.log", "text"], ["ci.yaml", "text"], ["ci.yml", "text"], ["app.ts", "text"], ["main.py", "text"],
  ["site.html", "page"],
  ["report.docx", "download"], ["data.zip", "download"], [".txt", "download"], ["Makefile", "download"],
])("%s opens as %s", (name, open) => {
  expect(fileOpen(`${W}${name}`)).toBe(open);
});

it("marks what the pane shows on a card, and a picture as before", () => {
  expect(["notes.md", "a.png", "deck.pdf", "site.html", "song.mp3", "clip.mp4", "b.docx"].map(paneKind)).toEqual(["text", "image", "pdf", "page", null, null, null]);
});

it("hands pictures and clips to the viewer and audio to the player", () => {
  const view = vi.fn();
  const play = vi.fn();
  for (const name of ["a.png", "clip.mp4", "song.mp3"]) openFile({ threadId: "t1", path: `${W}${name}` }, { view, play });
  expect(view.mock.calls).toEqual([
    [{ src: linkedFileSrc("t1", `${W}a.png`), name: "a.png", video: undefined }],
    [{ src: linkedFileSrc("t1", `${W}clip.mp4`), name: "clip.mp4", video: true }],
  ]);
  expect(play.mock.calls).toEqual([[linkedFileSrc("t1", `${W}song.mp3`)]]);
});

it.each([["deck.pdf", "pdf"], ["notes.md", "text"], ["site.html", "page"], ["a.png", "image"]])("shows %s in the pane as %s", (name, kind) => {
  openFile({ threadId: "t1", path: `${W}${name}` });
  expect(lastShown("t1")).toStrictEqual({ threadId: "t1", path: `${W}${name}`, kind });
});

it("downloads the rest in a browser and opens it in its app on the desktop", () => {
  openFile({ threadId: "t1", path: `${W}report.docx` });
  expect(saved.map((link) => [link.getAttribute("href"), link.download, link.target])).toEqual([[linkedFileSrc("t1", `${W}report.docx`), "report.docx", "_blank"]]);
  const open = vi.fn(async () => {});
  window.ogb = { openFile: open } as unknown as typeof window.ogb;
  openFile({ threadId: "t1", path: `${W}report.docx` });
  expect(open).toHaveBeenCalledWith(`${W}report.docx`);
  const rest = vi.fn();
  openFile({ threadId: "t1", path: `${W}report.docx` }, { rest });
  expect(rest).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
  expect(saved).toHaveLength(1);
});

it("shows a room's PDF and text from the room's own URL, and downloads its page and whole media", () => {
  const src = "/api/rooms/r1/files/1";
  window.ogb = { openFile: vi.fn(async () => {}) } as unknown as typeof window.ogb;
  for (const path of ["site.html", "clip.mp4", "song.mp3"]) openFile({ threadId: "r1", path, src });
  expect(saved.map((link) => link.getAttribute("href"))).toEqual([src, src, src]);
  openFile({ threadId: "r1", path: "plan.pdf", src });
  expect(lastShown("r1")).toStrictEqual({ threadId: "r1", path: "plan.pdf", kind: "pdf", src });
  openFile({ threadId: "r1", path: "notes.md", src });
  expect(lastShown("r1")).toStrictEqual({ threadId: "r1", path: "notes.md", kind: "text", src });
  expect(window.ogb!.openFile).not.toHaveBeenCalled();
});

it("downloads what the pane would show when no chat holds it", () => {
  openFile({ path: "plan.pdf", src: "/api/joined/rooms/r9/files/1" });
  expect(saved.map((link) => link.getAttribute("href"))).toEqual(["/api/joined/rooms/r9/files/1"]);
});

it("downloads nothing, not this page, when a save has no link", () => {
  saveFile("", "notes.md", `${W}notes.md`);
  expect(saved).toEqual([]);
});
