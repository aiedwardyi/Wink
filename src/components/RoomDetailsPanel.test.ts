// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JoinedView } from "@/lib/team-rooms";
import type { Action, Bot, Group, InstanceInfo } from "@/state/store";

const mock = vi.hoisted(() => ({
  // SAFETY: the panel reads only bots, instances and the profile name from state.
  state: { bots: [] as Bot[], instances: [] as InstanceInfo[], config: { profile: { name: "Edward" } } },
  dispatched: [] as Action[],
  joined: [] as JoinedView[],
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: mock.state, dispatch: (action: Action) => mock.dispatched.push(action), refreshInstances: () => Promise.resolve() }),
}));
vi.mock("@/lib/joined-rooms", async (original) => ({
  ...await original<typeof import("@/lib/joined-rooms")>(),
  useLoadedJoinedRooms: () => mock.joined,
}));

import { I18nProvider } from "@/lib/i18n";
import { RoomDetailsPanel } from "./RoomDetailsPanel";

const CODE = `wkr1:studio.example.test:inv_r1.wki_${"Q".repeat(43)}`;
const bot = (id: string, name: string): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "codex-1", model: "codex-default" }, messages: [],
});
const group: Group = { id: "group-1", threadId: "thread-1", name: "Channel", memberIds: [], defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 0, messages: [] };
const shared = (people: Array<{ id: string; name: string }>, memberIds = ["b1"]): Group => ({ ...group, memberIds, hosted: { roomId: "r1" }, room: { name: "Channel", people, joins: [] } });

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ method: string; path: string }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const section = (id: string) => host.querySelector<HTMLElement>(`[data-room-details-section="${id}"]`)!;
const button = (label: string) => [...document.querySelectorAll("button")].find((each) => each.textContent === label || each.getAttribute("aria-label") === label)!;
const confirm = (label: string) => act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button, [role="alertdialog"] button')].filter((each) => each.textContent === label).at(-1)!.click());

async function open(props: { group?: Group; joinedId?: string }, answer: (path: string, method: string) => Response = () => json({}), locale: "en" | "ko" = "en") {
  localStorage.setItem("omb-locale", locale);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path });
    return answer(path, init?.method ?? "GET");
  }));
  await act(async () => root.render(createElement(I18nProvider, null, createElement(RoomDetailsPanel, props))));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  mock.dispatched.length = 0;
  mock.state.bots = [];
  mock.state.instances = [];
  mock.joined = [];
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Room details", () => {
  it.each([
    ["en", "Room Details", "People", "Bots", "Room", "+ New bot"],
    ["ko", "채팅방 세부 정보", "참여자", "봇", "채팅방", "+ 새 봇"],
  ] as const)("titles the panel and its sections in %s", async (locale, title, people, bots, room, newBot) => {
    await open({ group }, undefined, locale);
    expect(host.querySelector("aside[data-room-details]")!.textContent).toContain(title);
    expect([...host.querySelectorAll("h3")].map((each) => each.textContent)).toEqual([people, bots, room]);
    expect(host.querySelector("[data-manage-create-bot]")!.textContent).toBe(newBot);
  });

  it("sits in Bot details' slot: 400px on desktop, full width on a phone", async () => {
    await open({ group });
    const panel = host.querySelector<HTMLElement>("aside[data-room-details]")!;
    expect(panel.hasAttribute("data-side-panel")).toBe(true);
    expect(panel.className.split(" ")).toEqual(expect.arrayContaining(["w-[400px]", "max-md:w-full", "max-md:absolute"]));
  });
});

describe("Bots", () => {
  it("draws one row per bot with a switch, no checkbox column", async () => {
    mock.state.bots = [bot("b1", "Wink"), bot("b2", "research Desk v2 / Seoul HQ")];
    await open({ group: { ...group, memberIds: ["b1"] } });
    const switches = [...section("bots").querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((each) => [each.getAttribute("aria-label"), each.getAttribute("aria-checked")])).toEqual([["Wink", "true"], ["research Desk v2 / Seoul HQ", "false"]]);
    expect(section("bots").querySelector('[role="checkbox"]')).toBeNull();
    await act(async () => switches[1]!.click());
    expect(mock.dispatched).toContainEqual({ type: "patchGroup", groupId: "group-1", patch: { memberIds: ["b1", "b2"] } });
  });

  it.each([[[], false], [["b1"], true]] as const)("says who answers only once a bot is in: %j", async (memberIds, told) => {
    mock.state.bots = [bot("b1", "Wink")];
    await open({ group: { ...group, memberIds: [...memberIds] } });
    expect(section("bots").textContent!.includes("Everyone responds")).toBe(told);
  });

  it.each([["shared", true], ["plain", false]] as const)("taking the last bot out of a %s group: %s", async (kind, allowed) => {
    mock.state.bots = [bot("b1", "Wink")];
    await open({ group: kind === "shared" ? shared([]) : { ...group, memberIds: ["b1"] } }, () => json({ roomId: "r1", code: CODE, carried: 0, group: shared([]) }));
    const toggle = section("bots").querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(!allowed);
    expect(section("bots").textContent!.includes("A group needs at least one bot.")).toBe(!allowed);
    await act(async () => toggle.click());
    expect(mock.dispatched.filter((action) => action.type === "patchGroup")).toEqual(allowed ? [{ type: "patchGroup", groupId: "group-1", patch: { memberIds: [] } }] : []);
  });

  it.each([
    ["en", "Name your bot", "For example, Researcher"],
    ["ko", "봇 이름 짓기", "예: 리서처"],
  ] as const)("adds a new bot to the room at once in %s", async (locale, label, placeholder) => {
    const existing = bot("existing", "Ada");
    const created = bot("created", "research Desk v2 / Seoul HQ");
    mock.state.bots = [existing];
    mock.state.instances = [{
      instanceId: "codex-1", driverKind: "codex", displayName: "Codex", snapshot: { state: "available", authenticated: true },
      models: { default: "codex-default", options: [{ id: "codex-default", label: "Codex Default" }, { id: "codex-pro", label: "Codex Pro" }] },
    }];
    const bodies: unknown[] = [];
    await open({ group: { ...group, memberIds: [existing.id], section: "Work" } }, () => json({ bot: created }, 201), locale);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_path: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ bot: created }, 201);
    });
    await act(async () => host.querySelector<HTMLButtonElement>("[data-manage-create-bot]")!.click());
    const name = host.querySelector<HTMLInputElement>('input[id^="group-wizard-name-"]')!;
    const selects = [...host.querySelectorAll("select")];
    expect(host.querySelector(`label[for="${name.id}"]`)?.textContent).toBe(label);
    expect(name.placeholder).toBe(placeholder);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(name, "  research Desk v2 / Seoul HQ  ");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(selects[1], "codex-pro");
      selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const add = [...host.querySelectorAll("button")].find((each) => !each.hasAttribute("data-manage-create-bot") && (each.textContent?.includes("Add bot") || each.textContent?.includes("봇 추가")))!;
    await act(async () => add.click());
    await settle();
    expect(bodies[0]).toEqual({ name: "research Desk v2 / Seoul HQ", modelSelection: { instanceId: "codex-1", model: "codex-pro" }, section: "Work" });
    expect(mock.dispatched).toContainEqual(expect.objectContaining({ type: "botAdded", bot: created }));
    expect(mock.dispatched).toContainEqual({ type: "patchGroup", groupId: "group-1", patch: { memberIds: [existing.id, created.id] } });
  });
});

describe("People", () => {
  it("shows a shared group's code and people at once, and Remove asks first and takes a fresh code", async () => {
    let code = CODE;
    await open({ group: shared([{ id: "p1", name: "Seo-yeon Park" }]) }, (_path, method) => {
      if (method === "DELETE") {
        code = CODE.replace("inv_r1", "inv_r2");
        return json({ ok: true });
      }
      return json({ roomId: "r1", code, carried: 0, group: shared([]) });
    });
    expect(section("people").querySelector("[data-team-room-code]")!.textContent).toContain(CODE);
    expect(section("people").textContent).toContain("Seo-yeon Park");
    expect(section("people").textContent).toContain("Edward");
    await act(async () => button("Remove Seo-yeon Park").click());
    await act(async () => button("Cancel").click());
    expect(calls).toHaveLength(1);
    await act(async () => button("Remove Seo-yeon Park").click());
    await confirm("Remove");
    await settle();
    expect(calls).toEqual([
      { method: "POST", path: "/api/groups/group-1/share" },
      { method: "DELETE", path: "/api/rooms/r1/people/p1" },
      { method: "POST", path: "/api/groups/group-1/share" },
    ]);
    expect(section("people").querySelector("[data-team-room-code]")!.textContent).toContain("inv_r2");
  });

  it("takes a people-only room's code from its own invite route and refreshes it after Remove", async () => {
    let removed = false;
    const room = shared([{ id: "mina", name: "Mina" }], []);
    await open({ group: room }, (_path, method) => {
      if (method === "DELETE") {
        removed = true;
        return json({ ok: true });
      }
      return json({ code: removed ? "fresh-code" : "old-code" });
    });
    expect(section("people").querySelector("[data-team-room-code]")!.textContent).toContain("old-code");
    await act(async () => button("Remove Mina").click());
    await confirm("Remove");
    await settle();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/rooms/r1/invites", "DELETE /api/rooms/r1/people/mina", "POST /api/rooms/r1/invites"]);
    expect(section("people").querySelector("[data-team-room-code]")!.textContent).toContain("fresh-code");
  });

  it("says Phone Access is off only after a tap on Invite, never on open", async () => {
    await open({ group: shared([{ id: "p1", name: "Mina" }], []) }, () => json({ error: "phone access is off" }, 409));
    expect(calls).toHaveLength(1);
    expect(section("people").querySelector('[role="alert"]')).toBeNull();
    expect(section("people").textContent).not.toContain("Turn on Phone Access");
    await act(async () => section("people").querySelector<HTMLButtonElement>("[data-group-invite]")!.click());
    await settle();
    expect(section("people").querySelector('[role="alert"]')!.textContent).toBe("Turn on Phone Access in Settings first.");
    await act(async () => button("Open Phone Access").click());
    expect(mock.dispatched).toContainEqual({ type: "toggleAppSettings", open: true, section: "companion" });
  });

  it("says why Invite has no code when the group is busy", async () => {
    await open({ group }, () => json({ error: "this group is working - finish that turn first" }, 409));
    expect(calls).toEqual([]);
    await act(async () => section("people").querySelector<HTMLButtonElement>("[data-group-invite]")!.click());
    await settle();
    expect(section("people").querySelector('[role="alert"]')!.textContent).toBe("This group is working. Try again when it's done.");
  });

  it("waits for Invite while a shared room is missing, and shows the code once it comes back", async () => {
    const answer = () => json({ roomId: "r1", code: CODE, carried: 0, group: shared([]) });
    await open({ group: { ...group, hosted: { roomId: "r1" }, room: { missing: true } } }, answer);
    expect(calls).toEqual([]);
    expect(section("people").querySelector("[data-group-invite]")).not.toBeNull();
    await act(async () => root.render(createElement(I18nProvider, null, createElement(RoomDetailsPanel, { group: shared([]) }))));
    await settle();
    expect(section("people").querySelector("[data-team-room-code]")!.textContent).toContain(CODE);
  });

  it("scrolls 40 people and 15 bots in one panel", async () => {
    mock.state.bots = Array.from({ length: 15 }, (_, i) => bot(`b${i}`, `Bot ${i}`));
    const crowd = shared(Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `Teammate ${i}` })), mock.state.bots.map((each) => each.id));
    await open({ group: crowd }, () => json({ roomId: "r1", code: CODE, carried: 0, group: crowd }));
    const body = section("people").parentElement!;
    expect(body.className.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]));
    expect(section("people").querySelectorAll("li")).toHaveLength(41);
    expect(section("bots").querySelectorAll('[role="switch"]')).toHaveLength(15);
  });
});

describe("a joined room", () => {
  const joined: JoinedView = {
    roomId: "j1", status: "joined", link: null, me: { id: "me", name: "Mina" },
    state: { roomName: "Studio", host: "Edward", people: [{ id: "me", name: "Mina" }, { id: "p2", name: "Seo-yeon Park" }] },
  };

  it("lists the host and people, has no Bots or code, and Leave asks first", async () => {
    mock.joined = [joined];
    await open({ joinedId: "j1" });
    expect([...host.querySelectorAll("h3")].map((each) => each.textContent)).toEqual(["People", "Room"]);
    expect(section("people").textContent).toContain("EdwardHost");
    expect(section("people").textContent).toContain("Seo-yeon Park");
    expect(section("people").querySelector("[data-group-invite], [data-team-room-code]")).toBeNull();
    await act(async () => button("Leave").click());
    expect(calls).toEqual([]);
    await confirm("Leave");
    expect(calls).toEqual([{ method: "POST", path: "/api/joined/rooms/j1/leave" }]);
  });
});
