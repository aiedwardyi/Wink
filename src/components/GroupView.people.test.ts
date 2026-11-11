// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Group, Message } from "@/state/store";
import type { RoomJoin } from "@/state/store-types";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state: { bots: [], instances: [], config: {} }, dispatch: () => undefined }),
    useStoreDispatch: () => () => undefined,
  };
});

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { GroupPeopleFaces } from "./GroupPeople";
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

  it("says the join line in Korean", async () => {
    localStorage.setItem("omb-locale", "ko");
    const host = await show([mine], [{ personId: "p1", name: "서연", at: day + 1 }]);
    expect(host.querySelector("[data-room-join]")?.textContent).toBe("서연 님이 참여했어요. 여기 있는 모두가 채팅 전체를 볼 수 있어요.");
  });
});

describe("header roster", () => {
  it("lists people as initials after the bots", async () => {
    const people = ["Seo-yeon Park", "Mina", "Jae", "Alexandra Kim"].map((name, i) => ({ id: `p${i}`, name }));
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(createElement(GroupPeopleFaces, { group: { ...group, room: { name: "Room", people, joins: [] } } })));
    const faces = document.querySelector("[data-group-people-faces]")!;
    expect(faces.textContent).toBe("SPMJ+1");
    expect(faces.getAttribute("title")).toBe("Seo-yeon Park, Mina, Jae, Alexandra Kim");
    const roster = groupView.slice(groupView.indexOf("<GroupMemberRoster"), groupView.indexOf("</GroupMemberRoster>"));
    expect(roster.indexOf("<GroupPeopleFaces")).toBeGreaterThan(-1);
    expect(roster.indexOf("<GroupPeopleFaces")).toBeLessThan(roster.indexOf("ref={membersTriggerRef}"));
  });

  it("draws nothing for a group nobody joined", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(createElement(GroupPeopleFaces, { group })));
    expect(document.querySelector("[data-group-people-faces]")).toBeNull();
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
