// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { RoomFilesFolderRow } from "./RoomFilesFolderRow";
import { TeamRoomFiles } from "./TeamRoomFiles";
import { TeamRoomRow } from "./TeamRoomRow";

const mock = vi.hoisted(() => ({ request: vi.fn(), showMedia: vi.fn(), phone: false }));
vi.mock("@/lib/api-request", () => ({ request: mock.request }));
vi.mock("@/lib/show-pane", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/show-pane")>(), showMedia: mock.showMedia }));
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
  mock.showMedia.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("room files", () => {
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

  it("lists the room's files as one row that opens Media", async () => {
    const onClose = vi.fn();
    const file = (name: string, type: string) => ({ id: name.padStart(24, "a"), name, bytes: 1024 ** 3, type, sender: "Mina", at: Date.now() });
    mock.request.mockResolvedValue({ files: [file("a.png", "image/png"), file("b.png", "image/png"), file("plan.pdf", "application/pdf")], used: 3 * 1024 ** 3, capacity: 100 * 1024 ** 3, error: null });
    await render(createElement(TeamRoomFiles, { roomId: "room1", threadId: "r-thread", closing: false, onClose }));
    expect(document.body.textContent).toContain("3 GB used / 100 GB");
    expect(document.querySelectorAll("[data-room-file]")).toHaveLength(0);
    const row = document.querySelector<HTMLButtonElement>("[data-room-media-row]")!;
    expect(row.textContent).toBe("Media and files3");
    await act(async () => row.click());
    expect(mock.showMedia).toHaveBeenCalledWith("r-thread");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an empty room's row at 0 and keeps the read-only notice, in Korean too", async () => {
    localStorage.setItem("omb-locale", "ko");
    mock.request.mockResolvedValue({ files: [], used: 0, capacity: 100 * 1024 ** 3, error: "unavailable" });
    await render(createElement(TeamRoomFiles, { roomId: "room1", threadId: "r-thread", closing: false, onClose: vi.fn() }));
    expect(document.querySelector("[data-room-media-row]")!.textContent).toBe("미디어와 파일0");
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("읽기 전용");
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
