// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Message } from "@/state/store";
import type { RoomJoin } from "@/state/store-types";

const storeState = vi.hoisted(() => ({ bots: [], instances: [], config: {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state: storeState, dispatch: () => undefined }),
    useStoreDispatch: () => () => undefined,
  };
});

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { Transcript } from "./GroupView";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "GroupView.tsx"), "utf8");

const day = Date.UTC(2026, 10, 12, 3);
const mine: Message = { id: "u1", role: "user", kind: "text", at: day, text: "Morning", author: { kind: "host", id: "host", name: "Host" }, roomEntryId: "e1" };
const theirs: Message = { id: "u2", role: "user", kind: "text", at: day + 60_000, text: "Hi all", author: { kind: "person", id: "p1", name: "Seo-yeon Park" }, roomEntryId: "e2" };
const group = { id: "room-1", name: "Room", threadId: "t1", memberIds: [], messages: [], hosted: { roomId: "r1" } } as unknown as Group;

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root?.unmount());
  root = null;
  applyLocale("en");
  localStorage.clear();
  document.body.innerHTML = "";
});

async function show(messages: Message[], joins?: RoomJoin[], readOnly = false, onMessageMenu: () => void = () => undefined) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(Transcript, {
    group, members: [], messages, transcript: messages, streamingMessage: null, dock: null, onReply: () => undefined, onMessageMenu, workers: [], joins, readOnly,
  }))));
  return host;
}

describe("people in a shared group's chat", () => {
  it("shows a teammate's line on the left under their name, never as you", async () => {
    const host = await show([mine, theirs]);
    const rows = [...host.querySelectorAll<HTMLElement>("[data-orbit-message]")];
    expect(rows[0]!.className).toContain("items-end");
    expect(rows[1]!.className).toContain("items-start");
    expect(rows[1]!.querySelector("[data-orbit-message-content]")!.className).not.toContain("bg-bubble-user");
    expect(host.querySelector('[data-mid="u2"]')!.textContent).toContain("Seo-yeon Park");
    expect(host.querySelector('[data-mid="u1"]')!.textContent).not.toContain("Host");
  });

  it("shows a teammate's picture and file the way the room does", async () => {
    const files = [{ id: "f1", name: "board.png", type: "image/png", bytes: 10 }, { id: "f2", name: "plan.pdf", type: "application/pdf", bytes: 20 }];
    const host = await show([{ ...theirs, text: "", roomFiles: files }]);
    const row = host.querySelector('[data-mid="u2"]')!;
    expect(row.querySelector("img[alt='board.png']")?.getAttribute("src")).toBe("/api/rooms/r1/files/f1/preview");
    expect(row.querySelector('a[download="plan.pdf"]')?.getAttribute("href")).toBe("/api/rooms/r1/files/f2");
  });

  it("names a teammate on a reaction, not as a bot", async () => {
    const host = await show([{ ...mine, reactions: [{ emoji: "👍", by: "person:p1" }] }, theirs]);
    expect(host.querySelector('[data-mid="u1"] [data-message-reactions] button')?.getAttribute("title")).toBe("Seo-yeon Park");
  });

  it("puts each first join where it happened, in the divider style", async () => {
    const host = await show([mine, theirs], [{ personId: "p1", name: "Seo-yeon Park", at: day + 30_000 }, { personId: "p2", name: "Mina", at: day + 120_000 }]);
    const lines = [...host.querySelectorAll<HTMLElement>("[data-room-join]")];
    expect(lines.map((line) => line.textContent)).toEqual([
      "Seo-yeon Park joined. Everyone here can see the whole chat.",
      "Mina joined. Everyone here can see the whole chat.",
    ]);
    expect(lines[0]!.className).toBe("py-2 text-center text-[12px] text-ink-secondary");
    expect(lines[0]!.closest("[data-mid]")?.getAttribute("data-mid")).toBe("u2");
    expect(lines[1]!.closest("[data-mid]")).toBeNull();
  });

  it("translates a teammate's line for the host, never the host's own, and links web addresses", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(
      url === "/api/rooms/r1/translate" ? { available: true } : url === "/api/rooms/r1/entries/e2/translate" && init?.method === "POST" ? { text: "Hi everyone" } : {},
    ), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const host = await show([{ ...mine, text: "안녕 https://example.com/a" }, { ...theirs, text: "다들 안녕 https://example.com/b" }]);
    expect(host.querySelector('[data-mid="u1"] [data-room-translate]')).toBeNull();
    expect(host.querySelector('[data-mid="u1"] a')?.getAttribute("href")).toBe("https://example.com/a");
    expect(host.querySelector('[data-mid="u2"] a')?.getAttribute("href")).toBe("https://example.com/b");
    const button = host.querySelector<HTMLButtonElement>('[data-mid="u2"] [data-room-translate]')!;
    await act(async () => button.click());
    expect(host.querySelector('[data-mid="u2"] [data-room-translation]')?.textContent).toBe("Hi everyone");
  });

  it("says the join line in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const host = await show([mine], [{ personId: "p1", name: "서연", at: day + 1 }]);
    expect(host.querySelector("[data-room-join]")?.textContent).toBe("서연 님이 참여했어요. 여기 있는 모두가 채팅 전체를 볼 수 있어요.");
  });
});

describe("an older task of a shared group", () => {
  it("swaps the composer for the read-only bar and drops join lines", () => {
    expect(groupView).toMatch(/\{archive \? \(\s*<GroupArchiveBar \/>\s*\) : \(/);
    expect(groupView).toContain("joins={archive ? undefined : roomJoins(group)}");
    expect(groupView).toContain("readOnly={Boolean(archive)}");
  });

  it("offers no reply, reaction, pin or menu on its lines", async () => {
    const menu = vi.fn();
    const reacted = { ...theirs, reactions: [{ emoji: "👍", by: "user" }] };
    const host = await show([mine, reacted], undefined, true, menu);
    expect(host.querySelector("[data-message-hover-actions]")).toBeNull();
    for (const row of host.querySelectorAll("[data-orbit-message]")) row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(menu).not.toHaveBeenCalled();
    const chip = host.querySelector("[data-mid=\"u2\"] [data-orbit-message-body] button");
    expect(chip?.closest(".pointer-events-none")).not.toBeNull();
  });
});
