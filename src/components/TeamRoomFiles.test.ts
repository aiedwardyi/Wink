// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { RoomFilesFolderRow } from "./RoomFilesFolderRow";
import { TeamRoomFilesMenu } from "./TeamRoomMenu";
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

  it("the header Files button opens Media for the room, with no dialog", async () => {
    await render(createElement(TeamRoomFilesMenu, { threadId: "r-thread" }));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Files"]')!.click());
    expect(mock.showMedia).toHaveBeenCalledWith("r-thread");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
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
