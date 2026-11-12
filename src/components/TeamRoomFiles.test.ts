// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { RoomFilesFolderRow } from "./RoomFilesFolderRow";
import { TeamRoomFiles } from "./TeamRoomFiles";
import { TeamRoomRow } from "./TeamRoomRow";

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

  it("confirms before deleting and refreshes the used space", async () => {
    const file = { id: "a".repeat(24), name: "계획.pdf", bytes: 1024 ** 3, type: "application/pdf", sender: "Mina", at: Date.now() };
    mock.request.mockResolvedValue({ files: [file], used: file.bytes, capacity: 100 * 1024 ** 3, error: null });
    await render(createElement(TeamRoomFiles, { roomId: "room1", closing: false, onClose: vi.fn() }));
    expect(document.body.textContent).toContain("1 GB used / 100 GB");
    await act(async () => document.querySelector<HTMLButtonElement>("[data-room-file] button")!.click());
    expect(mock.request).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Delete this file for everyone?");
    mock.request.mockResolvedValue({ files: [], used: 0, capacity: 100 * 1024 ** 3, error: null });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete" && button.closest('[aria-modal="true"]')?.getAttribute("data-room-files") === null)!;
    await act(async () => confirm.click());
    expect(mock.request).toHaveBeenCalledWith(`/api/rooms/room1/files/${file.id}`, { method: "DELETE" });
    expect(document.body.textContent).toContain("0 B used / 100 GB");
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
