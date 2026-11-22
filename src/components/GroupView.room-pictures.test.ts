// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Message } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: { bots: [], instances: [], config: {} }, dispatch: () => undefined }), useStoreDispatch: () => () => undefined };
});

import { I18nProvider } from "@/lib/i18n";
import { Transcript } from "./GroupView";

const CAT = { id: "c".repeat(24), name: "cat.png", type: "image/png", bytes: 9, sha256: "0".repeat(64) };
const group = { id: "room-1", name: "Room", threadId: "t1", memberIds: [], messages: [], hosted: { roomId: "r1" } } as unknown as Group;
const picture: Message = {
  id: "m1", role: "bot", kind: "text", at: 1, text: "A cat", roomEntryId: "e1", roomFiles: [CAT],
  author: { kind: "bot", id: "tb-1", name: "포키", owner: "jj" }, from: { botId: "tb-1", name: "포키", color: "teal" },
};

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
  root = null;
  document.body.innerHTML = "";
});

describe("a teammate bot's picture in the host's chat", () => {
  it("shows the picture, not just its caption", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(Transcript, {
      group, members: [], messages: [picture], transcript: [picture], streamingMessage: null, dock: null, onReply: () => undefined, onMessageMenu: () => undefined, workers: [],
    }))));
    expect([...host.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toContain(`/api/rooms/r1/files/${CAT.id}/preview`);
    expect(host.textContent).toContain("A cat");
  });
});

it("removes the host bot's inline preview when its room file is deleted", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const screen: Message = { ...picture, kind: "screen", shown: true };
  const render = (message: Message) => act(async () => root!.render(createElement(I18nProvider, null, createElement(Transcript, {
    group, members: [], messages: [message], transcript: [message], streamingMessage: null, dock: null, onReply: () => undefined, onMessageMenu: () => undefined, workers: [],
  }))));
  await render(screen);
  expect(host.querySelector(`img[src="/api/rooms/r1/files/${CAT.id}/preview"]`)).toBeTruthy();
  await render({ ...screen, roomFiles: [{ ...CAT, deleted: true }] });
  expect(host.querySelector(`img[src="/api/rooms/r1/files/${CAT.id}/preview"]`)).toBeNull();
  expect(host.textContent).toContain("A cat");
});
