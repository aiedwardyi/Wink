// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeamRoom } from "@/lib/team-rooms";

const mock = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: mock.dispatch }) }));
vi.mock("@/lib/i18n", () => {
  const t = (key: string) => key;
  return { t, useI18n: () => ({ t }) };
});

import { TeamRoomPeople } from "./TeamRoomPeople";

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  mock.dispatch.mockClear();
  document.body.innerHTML = "";
});

const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label)!;
const confirmRemove = () => act(async () => [...document.querySelectorAll('[role="dialog"] button')].find((candidate) => candidate.textContent === "teamRoom.remove" && candidate.closest('[aria-labelledby]'))!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("Remove", () => {
  it("asks first and removes only on confirm", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const removes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") removes.push(path);
      return new Response(JSON.stringify(path.endsWith("/invites") ? { code: "old-code" } : { ok: true }));
    }));
    const group = { id: "g1", name: "Team", hosted: { roomId: "r1" }, room: { name: "Team", people: [{ id: "mina", name: "Mina" }] } } as TeamRoom;
    root = createRoot(document.body.appendChild(document.createElement("main")));
    await act(async () => root!.render(createElement(TeamRoomPeople, { group, onClose: () => {}, triggerRef: { current: null } })));
    await act(async () => button("teamRoom.removeNamed").click());
    expect(removes).toEqual([]);
    expect(document.body.textContent).toContain("teamRoom.removeTitle");
    await act(async () => button("createBot.cancel").click());
    expect(removes).toEqual([]);
    await act(async () => button("teamRoom.removeNamed").click());
    await confirmRemove();
    expect(removes).toEqual(["/api/rooms/r1/people/mina"]);
  });
});

describe("Let back in", () => {
  it("lists removed teammates and lets one back in", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST" && !path.endsWith("/invites")) posts.push(path);
      return new Response(JSON.stringify(path.endsWith("/invites") ? { code: "old-code" } : { ok: true }));
    }));
    const group = { id: "g1", name: "Team", hosted: { roomId: "r1" }, room: { name: "Team", people: [{ id: "joon", name: "Joon" }], removed: [{ id: "mina", name: "Mina" }] } } as TeamRoom;
    root = createRoot(document.body.appendChild(document.createElement("main")));
    await act(async () => root!.render(createElement(TeamRoomPeople, { group, onClose: () => {}, triggerRef: { current: null } })));
    expect(document.querySelector("[data-room-removed]")?.textContent).toBe("MinateamRoom.letBack");
    await act(async () => button("teamRoom.letBackNamed").click());
    expect(posts).toEqual(["/api/rooms/r1/people/mina/back"]);
    expect(mock.dispatch).toHaveBeenCalledWith({ type: "groupPatched", group: { id: "g1", room: { ...group.room, removed: [] } } });
  });

  it("moves a removed teammate to the removed rows, or says the code changed when it was retired", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    for (const codeChanged of [false, true]) {
      vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => new Response(JSON.stringify(
        init?.method === "DELETE" ? { ok: true, ...(codeChanged ? { codeChanged } : {}) } : { code: "old-code" },
      ))));
      const group = { id: "g1", name: "Team", hosted: { roomId: "r1" }, room: { name: "Team", people: [{ id: "mina", name: "Mina" }] } } as TeamRoom;
      root = createRoot(document.body.appendChild(document.createElement("main")));
      await act(async () => root!.render(createElement(TeamRoomPeople, { group, onClose: () => {}, triggerRef: { current: null } })));
      await act(async () => button("teamRoom.removeNamed").click());
      await confirmRemove();
      expect(mock.dispatch).toHaveBeenLastCalledWith({ type: "groupPatched", group: { id: "g1", room: { ...group.room, people: [], removed: codeChanged ? [] : [{ id: "mina", name: "Mina" }] } } });
      expect(document.querySelector('[role="status"]')?.textContent).toBe(codeChanged ? "teamRoom.codeChanged" : undefined);
      await act(async () => root?.unmount());
      document.body.innerHTML = "";
    }
  });
});

describe("room code after removal", () => {
  it.each([200, 503])("drops the retired code when refreshing it returns %s", async (status) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let removed = false;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        removed = true;
        return new Response(JSON.stringify({ ok: true }));
      }
      if (path.endsWith("/invites")) {
        return new Response(JSON.stringify({ code: removed ? "fresh-code" : "old-code" }), { status: removed ? status : 200 });
      }
      return new Response(JSON.stringify({ groups: [] }));
    }));
    const group = { id: "g1", name: "Team", hosted: { roomId: "r1" }, room: { name: "Team", people: [{ id: "mina", name: "Mina" }] } } as TeamRoom;
    root = createRoot(document.body.appendChild(document.createElement("main")));
    await act(async () => root!.render(createElement(TeamRoomPeople, { group, onClose: () => {}, triggerRef: { current: null } })));
    expect(document.querySelector("[data-team-room-code]")?.textContent).toContain("old-code");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="teamRoom.removeNamed"]')!.click());
    await confirmRemove();
    expect(removed).toBe(true);
    expect(document.body.textContent).not.toContain("old-code");
    if (status === 200) expect(document.querySelector("[data-team-room-code]")?.textContent).toContain("fresh-code");
    else expect(document.querySelector('[role="alert"]')?.textContent).toBe("errors.request");
  });
});
