// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { mediaFile } from "@/lib/show-media";
import { closeShow, lastShown, linkedFileSrc } from "@/lib/show-pane";
import { roomFileUrl, type RoomFile } from "@/lib/team-rooms";
import { ChatMarkdown } from "./ChatMarkdown";
import { MediaViewerProvider } from "./MediaViewerProvider";
import { MediaFiles } from "./ShowMedia";
import { RoomFileRows } from "./TeamRoomRow";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
// a clip's first frame, so a card plays it in the viewer
vi.mock("@/lib/media-thumbs", () => ({ useThumb: (src: string) => (src ? "blob:poster" : null) }));
vi.mock("./ShowPdf", () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KINDS = {
  picture: "C:\\w\\shot.png",
  video: "C:\\w\\clip.mp4",
  audio: "C:\\w\\song.mp3",
  pdf: "C:\\w\\deck.pdf",
  text: "C:\\w\\notes.md",
  download: "C:\\w\\report.docx",
};
type Kind = keyof typeof KINDS;
const kinds = Object.keys(KINDS) as Kind[];

let root: Root;
let host: HTMLElement;
let saved: HTMLAnchorElement[];
let thread = "";
const sizes = ["clientWidth", "clientHeight"].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!] as const);

beforeEach(() => {
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this); });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
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
  Reflect.deleteProperty(window, "ogb");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, descriptor] of sizes) Object.defineProperty(HTMLElement.prototype, name, descriptor);
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); await settle(); };
const tap = async (el: Element | null | undefined) => { await act(async () => (el as HTMLElement).click()); await settle(); };
const desktop = () => { window.ogb = { openFile: vi.fn(async () => {}) } as unknown as typeof window.ogb; };
const chat = (text: string) => createElement(MediaViewerProvider, { threadId: thread, messages: [], children: createElement(ChatMarkdown, { text, threadId: thread }) });

/** What the tap did, in one line. */
function outcome(path: string): string {
  const linked = linkedFileSrc(thread, path);
  const viewer = document.querySelector("[data-media-viewer]");
  const shown = viewer?.querySelector("video, img")?.getAttribute("src");
  if (shown) return `viewer ${viewer!.querySelector("video") ? "clip" : "picture"}${shown === linked ? "" : ` ${shown}`}`;
  const audio = host.querySelector("audio");
  if (audio) return `plays${audio.getAttribute("src") === linked ? "" : ` ${audio.getAttribute("src")}`}`;
  const clip = host.querySelector("video");
  if (clip) return `plays clip${clip.getAttribute("src") === linked ? "" : ` ${clip.getAttribute("src")}`}`;
  const pane = lastShown(thread);
  if (pane?.path === path) return `pane ${pane.kind}`;
  if (saved.length) return `downloads${saved[0]!.getAttribute("href") === linked ? "" : ` ${saved[0]!.getAttribute("href")}`}`;
  const app = vi.mocked(window.ogb?.openFile);
  if (app?.mock.calls.length) return "opens in its app";
  return "nothing";
}

const DESKTOP: Record<Kind, string> = { picture: "viewer picture", video: "viewer clip", audio: "plays", pdf: "pane pdf", text: "pane text", download: "opens in its app" };
// A chat clip on the phone plays where it is; a Media clip opens the viewer on both.
const PHONE: Record<Kind, string> = { picture: "viewer picture", video: "plays clip", audio: "plays", pdf: "pane pdf", text: "pane text", download: "downloads" };
// a card shows for the files a card names, so its text file is a CSV
const card = (kind: Kind) => (kind === "text" ? "C:\\w\\data.csv" : KINDS[kind]);

describe.each([["desktop", DESKTOP], ["phone", PHONE]] as const)("on the %s", (where, expected) => {
  beforeEach(() => { if (where === "desktop") desktop(); });

  it.each(kinds)("a chat card for a %s opens by the one rule", async (kind) => {
    thread = `card-${where}-${kind}`;
    const path = card(kind);
    await render(chat(`[${path.split("\\").pop()}](${path})`));
    if (where === "desktop" || !["video", "audio"].includes(kind)) await tap(host.querySelector("[data-show-card], [data-file-link], a[download], button"));
    expect(outcome(path)).toBe(expected[kind]);
  });

  it.each(kinds)("a link to a %s inside a sentence opens by the one rule", async (kind) => {
    thread = `inline-${where}-${kind}`;
    const path = KINDS[kind];
    await render(chat(`See [the file](${path}) now.`));
    if (where === "desktop" || !["video", "audio"].includes(kind)) await tap(host.querySelector("[data-file-link], a[download]"));
    expect(outcome(path)).toBe(expected[kind]);
  });

  it.each(kinds)("a %s in Media opens by the one rule", async (kind) => {
    thread = `media-${where}-${kind}`;
    const path = KINDS[kind];
    const file = mediaFile(thread, { kind: "l", name: path.split("\\").pop()!, ref: path }, Date.now());
    await render(createElement(MediaFiles, { files: [file], pickFor: thread }));
    await tap(host.querySelector("[data-media-key]"));
    expect(outcome(path)).toBe(kind === "video" ? "viewer clip" : expected[kind]);
  });
});

describe("files only the PC holds, on the phone", () => {
  it.each(kinds)("an attached %s in Media streams from the PC", async (kind) => {
    thread = `attached-${kind}`;
    const path = KINDS[kind].replace("\\w\\", "\\att\\");
    const file = mediaFile(thread, { kind: "f", name: path.split("\\").pop()!, ref: path }, Date.now());
    await render(createElement(MediaFiles, { files: [file], pickFor: thread }));
    await tap(host.querySelector("[data-media-key]"));
    expect(outcome(path)).toBe(kind === "video" ? "viewer clip" : PHONE[kind]);
  });

  it.each([
    ["no answer", () => Promise.reject(new TypeError("offline")), "Your PC is offline"],
    ["a relay with no PC behind it", async () => new Response(null, { status: 502 }), "Your PC is offline"],
    ["no such file", async () => Response.json({ error: "not found" }, { status: 404 }), "That file no longer exists"],
  ] as const)("says so plainly when the PC gives %s", async (_, answer, said) => {
    thread = "gone";
    vi.stubGlobal("fetch", vi.fn(answer));
    await render(chat("See [the report](C:\\w\\report.docx) now."));
    await tap(host.querySelector("button"));
    expect(host.textContent).toContain(said);
    expect(host.textContent).not.toContain("Files open in the desktop app");
    expect(saved).toEqual([]);
  });

  it("says the PC is offline in Korean", async () => {
    thread = "gone-ko";
    applyLocale("ko");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    await render(chat("See [the report](C:\\w\\report.docx) now."));
    await tap(host.querySelector("button"));
    expect(host.textContent).toContain("PC가 오프라인 상태입니다");
  });

  it("says the PC is offline for a link with no extension, not that its folder can't be listed", async () => {
    thread = "gone-folder";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await render(chat("See [the notes](C:\\w\\README) now."));
    await tap(host.querySelector("button"));
    expect(host.textContent).toContain("Your PC is offline");
  });
});

describe("a link on the desktop", () => {
  it("opens in its app when the PC's own server gives no answer", async () => {
    thread = "desk-no-answer";
    const openFile = vi.fn(async (_path: string) => {});
    window.ogb = { openFile } as unknown as typeof window.ogb;
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    await render(chat("See [the deck](C:\\w\\deck.pdf) now."));
    await tap(host.querySelector("[data-file-link], [data-show-card]"));
    expect(openFile.mock.calls.map((call) => call[0])).toEqual(["C:\\w\\deck.pdf"]);
    expect(lastShown(thread)?.path).toBeUndefined();
  });
});

describe("a room's file rows", () => {
  const base = "/api/rooms/r1";
  const files: RoomFile[] = [
    { id: "a".repeat(24), name: "plan.pdf", type: "application/pdf", bytes: 4096 },
    { id: "b".repeat(24), name: "notes.md", type: "text/markdown", bytes: 10 },
    { id: "c".repeat(24), name: "sheet.xlsx", type: "application/octet-stream", bytes: 10 },
  ] as RoomFile[];
  const row = (name: string) => [...host.querySelectorAll("button")].find((each) => each.textContent?.includes(name));

  it("show a PDF and text in the room's pane from the room's URL, and download the rest", async () => {
    thread = "room";
    await render(createElement(RoomFileRows, { base, files, threadId: thread }));
    await tap(row("plan.pdf"));
    expect(lastShown(thread)).toStrictEqual({ threadId: thread, path: "plan.pdf", kind: "pdf", src: roomFileUrl(base, files[0]!, false) });
    await tap(row("notes.md"));
    expect(lastShown(thread)).toStrictEqual({ threadId: thread, path: "notes.md", kind: "text", src: roomFileUrl(base, files[1]!, false) });
    await tap(row("sheet.xlsx"));
    expect(saved.map((link) => [link.getAttribute("href"), link.download])).toEqual([[roomFileUrl(base, files[2]!, false), "sheet.xlsx"]]);
  });

  it("download in a room with no pane", async () => {
    await render(createElement(RoomFileRows, { base, files }));
    await tap(row("plan.pdf"));
    expect(saved.map((link) => link.getAttribute("href"))).toEqual([roomFileUrl(base, files[0]!, false)]);
  });
});
