// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSearchFindSeed } from "@/lib/chat-find";
import { PHONE_QUERY } from "@/lib/phone-swipe";
import type { JoinedView } from "@/lib/team-rooms";
import { setSaveStatus } from "@/state/description-save-status";
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
const order = () => [...host.querySelectorAll("[data-room-details-section]")].map((each) => each.getAttribute("data-room-details-section"));
const headings = () => [...host.querySelectorAll("h3")].map((each) => each.textContent);
const removeButtons = () => [...section("bots").querySelectorAll<HTMLButtonElement>("[data-room-bot] button")];
const bulletins = () => mock.dispatched.flatMap((action) => action.type === "patchGroup" && "bulletin" in action.patch ? [action.patch.bulletin] : []);
const type = (box: HTMLTextAreaElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
});
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
    ["en", "Room Details", "People (2)", "Bots (1)", "Add instructions for every bot…", "+ Add bot"],
    ["ko", "채팅방 세부 정보", "참여자 (2)", "봇 (1)", "모든 봇에게 줄 지침 추가…", "+ 봇 추가"],
  ] as const)("reads top down like group info in %s: room, people, bots", async (locale, title, people, bots, placeholder, addBot) => {
    mock.state.bots = [bot("b1", "Wink"), bot("b2", "Ada")];
    await open({ group: shared([{ id: "p1", name: "Mina" }]) }, () => json({ code: "old-code" }), locale);
    expect(host.querySelector("aside[data-room-details]")!.textContent).toContain(title);
    expect(order()).toEqual(["room", "people", "bots"]);
    expect(headings()).toEqual([people, bots]);
    const instructions = section("room").querySelector("textarea")!;
    expect(instructions.placeholder).toBe(placeholder);
    expect(instructions.getAttribute("rows")).toBe("1");
    expect(section("room").querySelector('[role="switch"]')).not.toBeNull();
    expect(host.querySelector("[data-room-add-bot]")!.textContent).toBe(addBot);
  });

  it("opens on a bot-to-bot channel with only its instructions", async () => {
    await open({ group: { ...group, dm: true, memberIds: ["b1", "b2"] } });
    expect(order()).toEqual(["room"]);
    expect(section("room").querySelector("textarea")).not.toBeNull();
  });

  it("saves instructions as you type, with Bot details' Saved cue", async () => {
    await open({ group });
    const box = section("room").querySelector("textarea")!;
    await act(async () => box.focus());
    await type(box, "Cite sources.");
    expect(bulletins()).toEqual([]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    expect(bulletins()).toEqual(["Cite sources."]);
    expect(section("room").textContent).not.toContain("Saved");
    await act(async () => setSaveStatus("group-1", "saved"));
    expect(section("room").textContent).toContain("Saved");
    await act(async () => box.blur());
    expect(bulletins()).toEqual(["Cite sources."]);
  });

  it("keeps instructions typed just before the panel closes", async () => {
    await open({ group });
    await type(section("room").querySelector("textarea")!, "Cite sources.");
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(bulletins()).toEqual(["Cite sources."]);
  });

  it("sends nothing when the instructions are only focused and left", async () => {
    await open({ group: { ...group, bulletin: "Old" } });
    const box = section("room").querySelector("textarea")!;
    await act(async () => box.focus());
    await act(async () => box.blur());
    expect(bulletins()).toEqual([]);
  });

  it("renames the room in place from the pencil, and saves on Enter", async () => {
    await open({ group: { ...group, name: "Channel" } });
    expect(section("room").querySelector("input")).toBeNull();
    await act(async () => button("Rename").click());
    const name = section("room").querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(name, "Studio");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(mock.dispatched).toContainEqual({ type: "patchGroup", groupId: "group-1", patch: { name: "Studio" } });
    expect(section("room").querySelector("input")).toBeNull();
  });

  it.each([
    ["Save name", ["Studio"]],
    ["Cancel", []],
  ])("%s beside the name input decides the rename, not the blur its press causes", async (label, saved) => {
    await open({ group: { ...group, name: "Channel" } });
    await act(async () => button("Rename").click());
    const name = section("room").querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(name, "Studio");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const press = button(label);
    await act(async () => {
      if (press.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))) name.blur();
      press.click();
    });
    expect(mock.dispatched.flatMap((action) => action.type === "patchGroup" && "name" in action.patch ? [action.patch.name] : [])).toEqual(saved);
    expect(section("room").querySelector("input")).toBeNull();
  });

  it("sits in Bot details' slot: 400px on desktop, full width on a phone", async () => {
    await open({ group });
    const panel = host.querySelector<HTMLElement>("aside[data-room-details]")!;
    expect(panel.hasAttribute("data-side-panel")).toBe(true);
    expect(panel.className.split(" ")).toEqual(expect.arrayContaining(["w-[400px]", "max-md:w-full", "max-md:absolute"]));
  });
});

describe("Bots", () => {
  it("lists only the bots in the room, and Add bot opens the picker with every bot", async () => {
    mock.state.bots = [bot("b1", "Wink"), bot("b2", "research Desk v2 / Seoul HQ"), bot("b3", "Ada")];
    await open({ group: { ...group, memberIds: ["b1", "b3"] } });
    expect([...section("bots").querySelectorAll("[data-room-bot]")].map((row) => row.getAttribute("data-room-bot"))).toEqual(["b1", "b3"]);
    expect(section("bots").querySelector('[role="switch"], [role="checkbox"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("[data-room-add-bot]")!.click());
    const picks = [...section("bots").querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(picks.map((each) => [each.textContent, each.getAttribute("aria-checked")])).toEqual([["Wink", "true"], ["research Desk v2 / Seoul HQ", "false"], ["Ada", "true"]]);
    await act(async () => picks[1]!.click());
    expect(mock.dispatched).toContainEqual({ type: "patchGroup", groupId: "group-1", patch: { memberIds: ["b1", "b3", "b2"] } });
    await act(async () => removeButtons()[1]!.click());
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
    const toggle = removeButtons()[0]!;
    expect(toggle.getAttribute("aria-label")).toBe("Remove Wink");
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
    await act(async () => host.querySelector<HTMLButtonElement>("[data-room-add-bot]")!.click());
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
    const add = [...host.querySelectorAll("button")].find((each) => !each.hasAttribute("data-manage-create-bot") && !each.hasAttribute("data-room-add-bot") && (each.textContent?.includes("Add bot") || each.textContent?.includes("봇 추가")))!;
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

  it.each([[[]], [["b1"]]] as const)("lists a removed teammate under the people and lets them back in (bots %j)", async (memberIds) => {
    const room = { ...shared([{ id: "p1", name: "Mina" }], [...memberIds]), room: { name: "Channel", people: [{ id: "p1", name: "Mina" }], joins: [], removed: [{ id: "p2", name: "Joon" }] } } as Group;
    await open({ group: room }, (path) => json(path.endsWith("/back") ? { ok: true } : { code: "old-code", roomId: "r1", carried: 0, group: room }));
    expect(section("people").querySelector("[data-room-removed]")!.textContent).toContain("Joon");
    await act(async () => button("Let Joon back in").click());
    await settle();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("POST /api/rooms/r1/people/p2/back");
    expect(mock.dispatched).toContainEqual({ type: "groupPatched", group: { id: "group-1", room: { ...room.room, removed: [] } } });
  });

  it.each([false, true])("moves a removed teammate to the removed rows, or says the code changed (retired %s)", async (codeChanged) => {
    const room = shared([{ id: "mina", name: "Mina" }], []);
    await open({ group: room }, (_path, method) => json(method === "DELETE" ? { ok: true, ...(codeChanged && { codeChanged }) } : { code: "old-code" }));
    expect(section("people").querySelector('[role="status"]')).toBeNull();
    await act(async () => button("Remove Mina").click());
    await confirm("Remove");
    await settle();
    expect(mock.dispatched).toContainEqual({ type: "groupPatched", group: { id: "group-1", room: { ...room.room, people: [], removed: codeChanged ? [] : [{ id: "mina", name: "Mina" }] } } });
    expect(section("people").querySelector('[role="status"]')?.textContent).toBe(codeChanged ? "The room code changed. Send the new one to your team." : undefined);
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

  it("shares a group once on its first Invite and keeps the code up", async () => {
    const now = shared([]);
    await open({ group }, () => json({ code: CODE, group: now }));
    await act(async () => section("people").querySelector<HTMLButtonElement>("[data-group-invite]")!.click());
    await settle();
    await act(async () => root.render(createElement(I18nProvider, null, createElement(RoomDetailsPanel, { group: now }))));
    await settle();
    expect(calls.filter((call) => call.path.endsWith("/share"))).toHaveLength(1);
    expect(section("people").textContent).toContain(CODE.slice(0, 12));
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

  it("lists teammates' bots with their owner in the host's Bots, and Remove takes one out", async () => {
    mock.state.bots = [bot("b1", "Wink")];
    const room = { ...shared([{ id: "p1", name: "Peter" }]), room: { name: "Channel", people: [{ id: "p1", name: "Peter" }], joins: [], teamBots: [{ id: "tb-A", name: "Pete-Coder", color: "teal", owner: "p1" }] } };
    await open({ group: room }, () => json({ code: "old-code" }));
    expect(headings()).toContain("Bots (2)");
    expect(section("bots").querySelector("[data-room-team-bot]")!.textContent).toContain("Pete-Coder · Peter's");
    await act(async () => button("Remove Pete-Coder").click());
    expect(calls).toContainEqual({ method: "DELETE", path: "/api/rooms/r1/bots/tb-A" });
  });

  it("scrolls 40 people and 15 bots in one panel", async () => {
    mock.state.bots = Array.from({ length: 15 }, (_, i) => bot(`b${i}`, `Bot ${i}`));
    const crowd = shared(Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `Teammate ${i}` })), mock.state.bots.map((each) => each.id));
    await open({ group: crowd }, () => json({ roomId: "r1", code: CODE, carried: 0, group: crowd }));
    const body = section("people").parentElement!;
    expect(body.className.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]));
    expect(section("people").querySelectorAll("li")).toHaveLength(41);
    expect(removeButtons()).toHaveLength(15);
  });
});

describe("room settings", () => {
  const kaiRay = { ...group, memberIds: ["b1", "b2"] };
  const bodies = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method === "PATCH").map(([path, init]) => [path, JSON.parse(String(init.body))]);

  it.each([
    ["en", "Folder", "Each bot's own folder"],
    ["ko", "폴더", "봇마다 자신의 폴더"],
  ] as const)("sets the room's folder from the Room section in %s", async (locale, label, empty) => {
    mock.state.bots = [bot("b1", "Kai"), bot("b2", "Ray")];
    vi.stubGlobal("ogb", { pickFolder: async () => "/Users/mina/work/wink-release-crew" });
    await open({ group: kaiRay }, () => json({ group: { ...kaiRay, cwd: "/Users/mina/work/wink-release-crew" } }), locale);
    const row = section("room").querySelector<HTMLElement>("[data-room-folder]")!;
    expect(row.textContent).toContain(label);
    expect(row.textContent).toContain(empty);
    await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    expect(bodies()).toEqual([["/api/groups/group-1", { cwd: "/Users/mina/work/wink-release-crew" }]]);
  });

  it("shows the folder a room already works in, fixed", async () => {
    mock.state.bots = [bot("b1", "Kai")];
    await open({ group: { ...group, memberIds: ["b1"], cwd: "/Users/mina/work/wink", pinnedCwd: "/Users/mina/work/wink" } });
    const row = section("room").querySelector<HTMLElement>("[data-room-folder]")!;
    expect(row.textContent).toContain("wink");
    expect(row.textContent).toContain("Every bot in this group uses this folder.");
    expect(row.querySelector("button, input")).toBeNull();
  });

  it("has no folder or who answers before a bot is in", async () => {
    await open({ group });
    expect(host.querySelector("[data-room-folder], [data-who-answers]")).toBeNull();
  });

  it.each([
    ["en", ["Everyone responds", "Kai", "research Desk v2 / Seoul HQ", "Only @mentioned members"]],
    ["ko", ["모두 응답", "Kai", "research Desk v2 / Seoul HQ", "@로 언급된 구성원만"]],
  ] as const)("picks who answers from the Bots section in %s", async (locale, options) => {
    mock.state.bots = [bot("b1", "Kai"), bot("b2", "research Desk v2 / Seoul HQ")];
    await open({ group: kaiRay }, undefined, locale);
    const pick = section("bots").querySelector<HTMLSelectElement>("select[data-who-answers]")!;
    expect([...pick.options].map((option) => option.textContent)).toEqual(options);
    expect(pick.value).toBe("everyone");
    for (const [value, responder] of [["member:b2", { kind: "member", botId: "b2" }], ["mentions", { kind: "mentions" }]] as const) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(pick, value);
        pick.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(mock.dispatched).toContainEqual({ type: "patchGroup", groupId: "group-1", patch: { defaultResponder: responder } });
    }
  });

  it.each([[true, 1], [false, 0]] as const)("Search this chat on a phone (%s) closes details and opens the chat's find bar", async (phone, rows) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone && query === PHONE_QUERY, media: query, addEventListener() {}, removeEventListener() {} }));
    const Probe = () => createElement("i", { "data-find-open": String(useSearchFindSeed("thread-1").findOpen) });
    const probe = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => probe.render(createElement(Probe)));
    mock.state.bots = [bot("b1", "Kai")];
    await open({ group: { ...group, memberIds: ["b1"] } });
    const search = [...section("room").querySelectorAll("button")].filter((each) => each.textContent === "Search this chat");
    expect(search).toHaveLength(rows);
    if (phone) {
      await act(async () => search[0]!.click());
      expect(mock.dispatched).toContainEqual({ type: "toggleSettings", open: false });
      expect(document.querySelector("[data-find-open]")!.getAttribute("data-find-open")).toBe("true");
    }
    await act(async () => probe.unmount());
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
    expect(order()).toEqual(["room", "people", "leave"]);
    expect(headings()).toEqual(["People (3)"]);
    expect(section("room").textContent).toContain("Studio");
    expect(section("room").querySelector("input, textarea, [data-room-picture-button]")).toBeNull();
    expect(section("people").textContent).toContain("EdwardHost");
    expect(section("people").textContent).toContain("Seo-yeon Park");
    expect(section("people").querySelector("[data-group-invite], [data-team-room-code]")).toBeNull();
    await act(async () => button("Leave").click());
    expect(calls).toEqual([]);
    await confirm("Leave");
    expect(calls).toEqual([{ method: "POST", path: "/api/joined/rooms/j1/leave" }]);
  });
  it("lists the room's bots once the host takes teammates' bots, and Add bot and Remove act on this PC's own", async () => {
    mock.state.bots = [bot("b1", "Scout"), bot("b2", "Ada")];
    mock.joined = [{
      ...joined,
      state: { ...joined.state!, bots: [{ id: "h1", name: "EdBot", color: "blue" }], teamBots: [{ id: "tb-A", name: "Scout", color: "teal", owner: "me" }, { id: "tb-B", name: "Mini", color: "", owner: "p2" }] },
      myBots: [{ id: "tb-A", botId: "b1" }],
    }];
    await open({ joinedId: "j1" });
    expect(order()).toEqual(["room", "people", "bots", "leave"]);
    expect(headings()).toEqual(["People (3)", "Bots (3)"]);
    expect([...section("bots").querySelectorAll("[data-room-team-bot]")].map((row) => row.textContent)).toEqual(["EdBot", "Scout · Mina'sRemove", "Mini · Seo-yeon Park's"]);
    await act(async () => button("Remove Scout").click());
    expect(calls).toContainEqual({ method: "DELETE", path: "/api/joined/rooms/j1/bots/tb-A" });
    await act(async () => host.querySelector<HTMLButtonElement>("[data-add-my-bot]")!.click());
    const picks = [...section("bots").querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(picks.map((each) => each.textContent)).toEqual(["Ada"]);
    await act(async () => picks[0]!.click());
    expect(calls).toContainEqual({ method: "POST", path: "/api/joined/rooms/j1/bots" });
  });
});
