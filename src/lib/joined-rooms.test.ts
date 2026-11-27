import "@/components/ProfileFields.test-dom.ts";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteJoinedFrame, useJoinedRooms } from "./joined-rooms";
import { openLiveEvents } from "./live-events";

vi.mock("./live-events", () => ({ openLiveEvents: vi.fn(() => () => {}) }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let requests: string[];

function Rooms() {
  useJoinedRooms();
  return null;
}

beforeEach(() => {
  requests = [];
  vi.mocked(openLiveEvents).mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(String(url));
    return Response.json({ rooms: [] });
  }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("joined room list", () => {
  it("loads once for every view that shows it and opens no stream of its own", async () => {
    await act(async () => {
      root.render(createElement(Fragment, null, ...[1, 2, 3, 4].map((key) => createElement(Rooms, { key }))));
    });
    expect(requests.filter((url) => url.includes("/api/joined/rooms"))).toHaveLength(1);
    expect(openLiveEvents).not.toHaveBeenCalled();
  });

  it("reloads once per frame from the page's stream", async () => {
    await act(async () => {
      root.render(createElement(Fragment, null, createElement(Rooms, { key: 1 }), createElement(Rooms, { key: 2 })));
    });
    await act(async () => noteJoinedFrame(null));
    expect(requests.filter((url) => url.includes("/api/joined/rooms"))).toHaveLength(2);
  });
});
