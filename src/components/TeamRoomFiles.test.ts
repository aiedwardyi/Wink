// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { RoomFilesFolderRow } from "./RoomFilesFolderRow";
import { MediaViewerProvider } from "./MediaViewerProvider";
import { RoomFileRows, TeamRoomRow } from "./TeamRoomRow";

const mock = vi.hoisted(() => ({ request: vi.fn(), phone: false }));
vi.mock("@/lib/api-request", () => ({ request: mock.request }));
vi.mock("@/lib/use-phone-swipe", () => ({ useIsPhone: () => mock.phone }));

let root: Root;
let host: HTMLDivElement;
const render = async (element: React.ReactNode) => {
  await act(async () => root.render(createElement(I18nProvider, null, element)));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("omb-locale", "en");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  mock.phone = false;
  mock.request.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("room files", () => {
  it.each(["/api/rooms/r1", "/api/joined/rooms/r1"])("opens a video in the viewer from %s", async (base) => {
    const files = [{ id: "a".repeat(24), name: "clip.mp4", type: "video/mp4", bytes: 100 }, { id: "b".repeat(24), name: "plan.pdf", type: "application/pdf", bytes: 200 }];
    await render(createElement(MediaViewerProvider, { threadId: "room", messages: [], children: createElement(RoomFileRows, { base, files }) }));
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("clip.mp4"));
    expect(button).toBeDefined();
    expect([...host.querySelectorAll("[data-room-file]")].map((row) => row.textContent?.includes("plan.pdf"))).toEqual([false, true]);
    await act(async () => button!.click());
    expect(document.querySelector("[data-media-viewer] video")?.getAttribute("src")).toBe(`${base}/files/${files[0]!.id}`);
  });

  it.each(["/api/rooms/r1", "/api/joined/rooms/r1"])("opens a clip its name doesn't mark from %s, and still downloads other files", async (base) => {
    const files = [
      { id: "a".repeat(24), name: "recording.mkv", type: "video/webm", bytes: 100 },
      { id: "b".repeat(24), name: "clip", type: "video/mp4", bytes: 100 },
      { id: "c".repeat(24), name: "notes", type: "text/plain", bytes: 100 },
    ];
    await render(createElement(MediaViewerProvider, { threadId: "room", messages: [], children: createElement(RoomFileRows, { base, files }) }));
    const saved: Array<string | null> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.getAttribute("href")); });
    const rows = [...host.querySelectorAll<HTMLButtonElement>("[data-room-file]")];
    for (const [at, file] of files.slice(0, 2).entries()) {
      await act(async () => rows[at]!.click());
      expect(document.querySelector("[data-media-viewer] video")?.getAttribute("src")).toBe(`${base}/files/${file.id}`);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(document.querySelector("[data-media-viewer]")).toBeNull();
    }
    await act(async () => rows[2]!.click());
    expect(document.querySelector("[data-media-viewer]")).toBeNull();
    expect(saved).toEqual([`${base}/files/${files[2]!.id}`]);
    click.mockRestore();
  });

  it("uses the desktop picker and keeps the path when a move fails", async () => {
    const pickFolder = vi.fn(async () => "D:\\Team files");
    vi.stubGlobal("ogb", { pickFolder });
    mock.request.mockResolvedValueOnce({ path: "C:\\Room files", error: null }).mockRejectedValueOnce(new Error("disk"));
    await render(createElement(RoomFilesFolderRow));
    await act(async () => host.querySelector("button")!.click());
    expect(pickFolder).toHaveBeenCalledWith("C:\\Room files");
    expect(mock.request).toHaveBeenLastCalledWith("/api/room-files-folder", { method: "PUT", body: JSON.stringify({ path: "D:\\Team files" }) });
    expect(host.textContent).toContain("C:\\Room files");
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.textContent).toContain("The current folder is still in use.");
  });

  it("hides folder settings in a browser and on a phone", async () => {
    vi.stubGlobal("ogb", undefined);
    await render(createElement(RoomFilesFolderRow));
    expect(host.textContent).toBe("");
    mock.phone = true;
    vi.stubGlobal("ogb", { pickFolder: vi.fn() });
    await render(createElement(RoomFilesFolderRow));
    expect(host.textContent).toBe("");
    expect(mock.request).not.toHaveBeenCalled();
  });

  it("renders a deleted file without a download or preview in both languages", () => {
    const line = { id: "m1", at: Date.now(), text: "", author: { kind: "host" as const, id: "host", name: "Edward" }, files: [{ id: "a".repeat(24), name: "photo.png", type: "image/png", bytes: 100, deleted: true }] };
    for (const [locale, text] of [["en", "File deleted"], ["ko", "파일 삭제됨"]]) {
      localStorage.setItem("omb-locale", locale!);
      const markup = renderToStaticMarkup(createElement(I18nProvider, null, createElement(TeamRoomRow, { line, mine: true, named: false, base: "/api/rooms/room1", onJump: () => {}, onMenu: () => {}, onReply: () => {} })));
      expect(markup).toContain(text);
      expect(markup).not.toContain("href=");
      expect(markup).not.toContain("<img");
    }
  });
});
