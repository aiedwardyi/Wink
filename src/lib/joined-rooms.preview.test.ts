import "@/components/ProfileFields.test-dom.ts";
import { act, createElement, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPreviewContext } from "./chat-preview";
import { forgetJoinedRoom, noteJoinedRoom, useJoinedRoom, type JoinedRoomDetail } from "./joined-rooms";
import type { JoinedEntry, JoinedView } from "./team-rooms";
import { openLiveEvents } from "./live-events";

vi.mock("./live-events", () => ({ openLiveEvents: vi.fn(() => () => {}) }));

const summary = (roomId: string): JoinedView => ({ roomId, status: "joined", link: "live", me: { id: "me", name: "Me" }, state: { roomName: roomId, host: "Host", people: [] } });
const entries = (count: number): JoinedEntry[] => Array.from({ length: count }, (_, seq) => ({ seq, id: `entry-${seq}`, at: 1, author: { kind: "host", id: "host", name: "Host" }, text: `Cached ${seq}` }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let detail: JoinedRoomDetail | null | undefined;
let requests: string[];
let answer: JoinedRoomDetail;
let firstPagePending: boolean;

function View({ roomId, limit, beforeOlder }: { roomId: string; limit?: number; beforeOlder?: RefObject<(() => void) | null> }) {
  detail = useJoinedRoom(roomId, limit, beforeOlder);
  return null;
}

const render = (roomId: string, preview: boolean, key = "view") => act(async () => {
  root.render(createElement(ChatPreviewContext.Provider, { value: preview }, createElement(View, { roomId, key })));
});

beforeEach(() => {
  detail = undefined;
  requests = [];
  firstPagePending = false;
  answer = { ...summary("room-a"), entries: entries(240), hasMore: false };
  vi.mocked(openLiveEvents).mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(String(url));
    if (firstPagePending && !String(url).includes("limit=")) return new Promise<Response>(() => {});
    return Response.json({ room: answer });
  }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  forgetJoinedRoom("room-a");
  forgetJoinedRoom("room-b");
  vi.unstubAllGlobals();
});

describe("joined room preview cache", () => {
  it("uses already loaded room metadata without starting a detail read or live subscription", async () => {
    noteJoinedRoom(summary("room-a"));
    await render("room-a", true);
    expect(detail?.state?.roomName).toBe("room-a");
    expect(detail?.entries).toEqual([]);
    expect(requests).toEqual([]);
    expect(openLiveEvents).not.toHaveBeenCalled();
  });

  it("retains only the newest 200 entries of the last live room", async () => {
    await render("room-a", false);
    expect(detail?.entries).toHaveLength(240);
    requests.length = 0;
    vi.mocked(openLiveEvents).mockClear();
    await render("room-a", true, "preview");
    expect(detail?.entries).toHaveLength(200);
    expect(detail?.entries[0].seq).toBe(40);
    expect(detail?.hasMore).toBe(true);
    expect(requests).toEqual([]);
    expect(openLiveEvents).not.toHaveBeenCalled();
  });

  it("does not reuse another room's detail and starts the normal read on promotion", async () => {
    await render("room-a", false);
    noteJoinedRoom(summary("room-b"));
    requests.length = 0;
    await render("room-b", true, "preview");
    expect(detail?.state?.roomName).toBe("room-b");
    expect(detail?.entries).toEqual([]);
    expect(requests).toEqual([]);
    answer = { ...summary("room-b"), entries: entries(2) };
    await render("room-b", false, "preview");
    expect(requests).toEqual(["/api/joined/rooms/room-b"]);
    expect(detail?.entries).toHaveLength(2);
  });

  it("keeps the reader's place when an older page lands before a remount's first read", async () => {
    await render("room-a", false);
    firstPagePending = true;
    const beforeOlder = { current: vi.fn() };
    const remount = (limit: number) => act(async () => root.render(createElement(View, { roomId: "room-a", limit, beforeOlder, key: "remount" })));
    await remount(200);
    expect(detail?.entries[0].seq).toBe(40);
    await remount(400);
    expect(requests.at(-1)).toBe("/api/joined/rooms/room-a?limit=400");
    expect(detail?.entries[0].seq).toBe(0);
    expect(beforeOlder.current).toHaveBeenCalledTimes(1);
  });

  it("drops a forgotten room's retained tail", async () => {
    await render("room-a", false);
    forgetJoinedRoom("room-a");
    noteJoinedRoom(summary("room-a"));
    requests.length = 0;
    await render("room-a", true, "preview");
    expect(detail?.entries).toEqual([]);
    expect(requests).toEqual([]);
  });
});
