import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";
import { TeamRoomTranscript } from "./TeamRoomRow";

vi.mock("@/lib/room-translate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/room-translate")>(),
  useTranslationAvailable: () => false,
}));

let root: Root | null = null;
let resize: () => void;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(TeamRoomTranscript, { onReply: () => {},
    lines: [{ id: "picture", at: Date.now(), author: { kind: "host", id: "host", name: "Mina" }, text: "", files: [{ id: "file", name: "design.png", bytes: 100, type: "image/png" }] }],
    mine: () => false, base: "/api/rooms/r1", label: "Design team",
  }))));
  const pane = host.querySelector<HTMLElement>("[data-team-room-transcript]")!;
  let height = 1000;
  let viewport = 500;
  let top = 500;
  Object.defineProperties(pane, {
    clientHeight: { get: () => viewport }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.min(height - viewport, value); } },
  });
  return { pane, grow: () => { height += 220; }, expand: () => { viewport += 100; top = Math.min(height - viewport, top); } };
}

it("stays at the exact bottom when picture growth sends a scroll before the resize callback", async () => {
  const { pane, grow } = await mount();
  grow();
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  await act(async () => resize());
  expect(pane.scrollHeight - pane.scrollTop - pane.clientHeight).toBe(0);
});

it("does not pull a reader back down after an upward wheel gesture", async () => {
  const { pane, grow } = await mount();
  const wheel = new Event("wheel", { bubbles: true });
  Object.defineProperty(wheel, "deltaY", { value: -100 });
  await act(async () => pane.dispatchEvent(wheel));
  pane.scrollTop = 300;
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  grow();
  await act(async () => resize());
  expect(pane.scrollTop).toBe(300);
});

it("keeps the scrollbar's upward position when a picture grows", async () => {
  const { pane, grow } = await mount();
  await act(async () => resize());
  pane.scrollTop = 300;
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  grow();
  await act(async () => resize());
  expect(pane.scrollTop).toBe(300);
});

it("keeps following when a taller viewport moves the scroll position upward", async () => {
  const { pane, grow, expand } = await mount();
  await act(async () => resize());
  expand();
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  grow();
  await act(async () => resize());
  expect(pane.scrollHeight - pane.scrollTop - pane.clientHeight).toBe(0);
});

it("labels old lines by current author id and keeps departed names", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const lines: RoomLine[] = [
    { id: "a", at: 1, author: { kind: "person", id: "p1", name: "Mina" }, text: "old line", files: [] },
    { id: "b", at: 2, author: { kind: "host", id: "host", name: "Edward" }, text: "host line", files: [] },
    { id: "c", at: 3, author: { kind: "person", id: "gone", name: "Daniel Cho" }, text: "left", files: [] },
  ];
  try {
    await act(async () => root.render(createElement(TeamRoomTranscript, { onReply: () => {},
      lines, mine: () => false, base: "", label: "Room", hostName: "에드워드", people: [{ id: "p1", name: "민아" }],
    })));
    expect(host.textContent).toContain("민아");
    expect(host.textContent).toContain("에드워드");
    expect(host.textContent).toContain("Daniel Cho");
    expect(host.textContent).not.toContain("Mina");
  } finally {
    await act(async () => root.unmount());
  }
});
