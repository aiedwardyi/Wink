// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { useStore } from "@/state/store";
import type { Group, Message } from "@/state/store-types";

const store = vi.hoisted(() => ({ dispatch: null as ReturnType<typeof useStore>["dispatch"] | null, selectedId: "" }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => {
    const value = actual.useStore();
    store.dispatch = value.dispatch;
    store.selectedId = value.state.selectedId;
    return value;
  } };
});

import App from "./App";
import { endSelectMode } from "./components/MessageMenu";

const CODE = `wkr1:edward-pc.tail1234.ts.net:inv_mina.wki_${"A".repeat(43)}`;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
}

type Call = { path: string; method: string; body: unknown };
type Answer = Response | Promise<Response> | undefined;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const nova = { id: "nova", threadId: "nova-thread", name: "Nova", modelSelection: { instanceId: "claude", model: "default" }, messages: [] };

const line = (id: string, author: { kind: "host" | "person"; id: string; name: string }, text: string, roomFiles: Message["roomFiles"] = []): Message =>
  ({ id, role: "user", kind: "text", text, at: Date.UTC(2026, 10, 11, 9, 0), author, roomEntryId: `e-${id}`, roomFiles });

const teamRoom = (people: Array<{ id: string; name: string }> = [], messages: Message[] = []) =>
  ({ id: "g1", threadId: "g1-thread", name: "Design team", memberIds: [], bulletin: "", messages, hosted: { roomId: "r1" }, room: { name: "Design team", people } }) as unknown as Group;

const joinedView = (status: "joined" | "removed" | "left", link: "connecting" | "live" | "offline" | null) => ({
  roomId: "r9",
  status,
  link,
  me: { id: "p-mina", name: "Mina" },
  state: { roomName: "Design team", host: "Edward", people: [{ id: "p-mina", name: "Mina" }] },
});

const joinedEntries = [
  { seq: 1, id: "j1", at: Date.UTC(2026, 10, 11, 9, 0), author: { kind: "host", id: "host", name: "Edward" }, text: "Welcome", files: [{ id: "F".repeat(24), name: "map.png", type: "image/png", bytes: 2048, sha256: "a" }] },
  { seq: 2, id: "j2", at: Date.UTC(2026, 10, 11, 9, 1), author: { kind: "person", id: "p-mina", name: "Mina" }, text: "Thanks", files: [{ id: "G".repeat(24), name: "notes.pdf", type: "application/pdf", bytes: 4096, sha256: "b" }] },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let calls: Call[] = [];

async function boot({ groups = [], route = () => undefined, locale = "en" }: {
  groups?: Group[];
  route?: (call: Call, init?: RequestInit) => Answer;
  locale?: "en" | "ko";
}) {
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem("omb-locale", locale);
  calls = [];
  FakeEventSource.all = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
    const call = { path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
    calls.push(call);
    return route(call, init) ?? new Promise<Response>(() => {});
  }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await act(async () => {
    store.dispatch!({ type: "instances", instances: [{
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
      snapshot: { state: "available" }, models: { default: "default", options: [] },
    }] } as never);
    store.dispatch!({ type: "connected", value: true });
    store.dispatch!({ type: "configStatus", config: { features: {} } as never });
    store.dispatch!({ type: "hydrate", bots: [nova], groups, botsUnreadable: false, computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } } as never);
  });
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.getAttribute("aria-label") === label || each.textContent?.trim() === label);
const found = <T,>(get: () => T | null | undefined) => vi.waitFor(() => {
  const value = get();
  if (!value) throw new Error("not on screen yet");
  return value;
});
// the sidebar folds for Room details, and happy-dom reports a canceled fold as unhandled
async function openDetails(name = "Design team, Open room details") {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => query === "(prefers-reduced-motion: reduce)" ? { matches: true } as MediaQueryList : matchMedia(query));
  await click(button(name)!);
  return found(() => $("aside[data-room-details]"));
}
async function click(target: Element | null | undefined) {
  expect(target, "control on screen").toBeTruthy();
  await act(async () => { (target as HTMLElement).click(); });
}

async function type(target: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(target, "field on screen").toBeTruthy();
  await act(async () => {
    if (!target) return;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function paste(target: HTMLInputElement | null, text: string) {
  expect(target, "field on screen").toBeTruthy();
  await act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], getData: () => text } });
    target!.dispatchEvent(event);
  });
}

async function enter(target: Element | null) {
  expect(target, "field on screen").toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  });
}

async function openPlus() {
  await click(button("New or share") ?? button("새로 만들기 또는 공유"));
}

const joinedSource = () => FakeEventSource.all.find((source) => source.url.includes("screens=off"));

async function joinedFrame(roomId: string) {
  await act(async () => joinedSource()!.onmessage?.({ data: JSON.stringify({ kind: "joined", hosted: true, roomId }), lastEventId: `${Date.now()}` }));
}

const asked = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root!.unmount());
  endSelectMode();
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  store.dispatch = null;
});

describe.each(["host", "joined"] as const)("Team room message menu on %s", (side) => {
  async function openRoom(locale: "en" | "ko" = "en") {
    const original = line("original", { kind: "person", id: "p-mina", name: "Mina Park" }, "PR #1304 머지했어요");
    const own = line("own", { kind: "host", id: "host", name: "Daniel Cho" }, "Ready");
    const quoted = { ...own, id: "quoted", replyToId: original.id, text: "Thanks" };
    const entries = [original, own, quoted].map((message, index) => ({
      ...message, seq: index + 1, files: [],
      author: message.author?.kind === "host" ? { kind: "person", id: "p-mina", name: "Mina Park" } : { kind: "host", id: "host", name: "Daniel Cho" },
    }));
    await boot({ locale, groups: side === "host" ? [teamRoom([], [original, own, quoted])] : [], route: (call) => {
      if (call.path === "/api/joined/rooms") return reply({ rooms: [joinedView("joined", "live")] });
      if (call.path === "/api/joined/rooms/r9") return reply({ room: { ...joinedView("joined", "live"), entries } });
      if (call.path.includes("/files?")) return reply({ file: { id: "quoted-file" } });
      if (call.path.endsWith("/send")) return reply({ ok: true });
      return undefined;
    } });
    await act(async () => store.dispatch!({ type: "select", id: side === "host" ? "g1" : "joined:r9" }));
    await vi.waitFor(() => expect($("[data-mid=original]")).not.toBeNull());
  }

  async function menu(id = "original") {
    await act(async () => { $("[data-mid=" + id + "] [data-team-room-content]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })); });
    expect($("[data-message-menu]")).not.toBeNull();
  }

  it("copies either author, closes on scroll, and sends a quoted reply with the entry id", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openRoom();
    for (const id of ["original", "own"]) {
      await menu(id);
      expect([...document.querySelectorAll("[data-message-menu] [role=menuitem]:not([data-menu-expand])")].map((el) => el.textContent)).toEqual([...(side === "host" ? ["Pin as notice"] : []), "Reply", "Copy"]);
      await click($("[data-menu-copy]"));
    }
    expect(writeText.mock.calls).toEqual([["PR #1304 머지했어요"], ["Ready"]]);
    await menu();
    await act(async () => { $("[data-team-room-transcript]")!.dispatchEvent(new Event("scroll")); });
    expect($("[data-message-menu]")).toBeNull();
    await menu();
    await click($("[data-menu-reply]"));
    expect(button("Cancel reply")).toBeTruthy();
    expect(document.activeElement).toBe($("main textarea"));
    await type($("main textarea"), "Reply text");
    const picker = $<HTMLInputElement>('main input[type="file"]:not([data-room-picture-input])')!;
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [new File(["notes"], "reply.txt", { type: "text/plain" })], configurable: true });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("Send message"));
    const path = side === "host" ? "/api/rooms/r1/send" : "/api/joined/rooms/r9/send";
    await vi.waitFor(() => expect(asked("POST", path)[0]?.body).toMatchObject({ text: "Reply text", replyToId: side === "host" ? "e-original" : "original", fileIds: ["quoted-file"] }));
    expect(button("Cancel reply")).toBeUndefined();
  });

  it("jumps to a loaded original and Escape closes the menu before the quote", async () => {
    await openRoom();
    const original = $("[data-mid=original]")!;
    const scrollIntoView = vi.fn();
    Object.assign(original, { scrollIntoView });
    await click($('[data-mid=quoted] button[title="Jump to original message"]'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    await menu();
    await click($("[data-menu-reply]"));
    await menu("own");
    const escape = () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await escape();
    expect($("[data-message-menu]")).toBeNull();
    expect(button("Cancel reply")).toBeTruthy();
    await escape();
    expect(button("Cancel reply")).toBeUndefined();
  });

  it("holds for 500 ms, labels the touch menu in Korean and closes it with Back", async () => {
    await openRoom("ko");
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("coarse"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const row = $("[data-mid=original] [data-team-room-content]")!;
    const event = new Event("touchstart", { bubbles: true });
    Object.defineProperty(event, "touches", { value: [{ clientX: 100, clientY: 100 }] });
    await act(async () => { row.dispatchEvent(event); });
    await act(async () => vi.advanceTimersByTime(499));
    expect($("[data-message-menu]")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect([...document.querySelectorAll("[data-message-menu] [role=menuitem]:not([data-menu-expand])")].map((el) => el.textContent)).toEqual([...(side === "host" ? ["공지로 등록"] : []), "답장", "복사", "텍스트 선택"]);
    await act(async () => { window.dispatchEvent(new Event("orbit:close-message-menu")); });
    expect($("[data-message-menu]")).toBeNull();
    await act(async () => { row.dispatchEvent(event); vi.advanceTimersByTime(500); });
    await click($("[data-menu-select]"));
    expect($("[data-mid=original]")?.hasAttribute("data-select-mode")).toBe(true);
    expect(window.getSelection()?.toString()).toBe("PR #1304 머지했어요");
    await act(async () => endSelectMode());
  });
});

describe("Team rooms for the host", () => {
  it("reads joined lines only on an active room and clears the row on every client frame", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    let unread = 3;
    const entries = [1, 2, 3].map((seq) => ({ ...joinedEntries[0], seq, id: `j${seq}` }));
    const view = () => ({ ...joinedView("joined", "live"), unread, lastEntry: entries.at(-1) });
    await boot({ route: (call) => {
      if (call.path === "/api/joined/rooms") return reply({ rooms: [view()] });
      if (call.path === "/api/joined/rooms/r9") return reply({ room: { ...view(), entries } });
      if (call.path === "/api/joined/rooms/r9/read") {
        unread = 0;
        return reply({ room: view() });
      }
      return undefined;
    } });
    await act(async () => store.dispatch!({ type: "select", id: "joined:r9" }));
    await vi.waitFor(() => expect($('[data-team-room="joined"] [data-team-room-line]')).not.toBeNull());
    expect(asked("POST", "/api/joined/rooms/r9/read")).toHaveLength(0);
    focus.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(asked("POST", "/api/joined/rooms/r9/read").map((call) => call.body)).toEqual([{ seq: 3 }]);
    await joinedFrame("r9");
    await vi.waitFor(() => expect($('[data-joined-room-row] [data-sidebar-unread-count]')).toBeNull());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(asked("POST", "/api/joined/rooms/r9/read")).toHaveLength(1);
  });

  it("counts joined teammate lines on the row and menu, then clears on a read frame", async () => {
    let unread = 3;
    const view = () => ({ ...joinedView("joined", "live"), unread, lastEntry: joinedEntries[0] });
    await boot({ route: (call) => {
      if (call.path === "/api/joined/rooms") return reply({ rooms: [view()] });
      return undefined;
    } });
    await vi.waitFor(() => expect($('[data-joined-room-row]')).not.toBeNull());
    expect($('[data-joined-room-row] [data-sidebar-unread-count]')?.textContent).toBe("3");
    expect($('[data-menu-unread]')?.textContent).toBe("3");
    expect($('[data-joined-room-row]')?.textContent).toContain("Edward: Welcome");
    unread = 0;
    await joinedFrame("r9");
    await vi.waitFor(() => expect($('[data-menu-unread]')).toBeNull());
    expect($('[data-joined-room-row] [data-sidebar-unread-count]')).toBeNull();
  });

  it.each(["Join with code"])("Back closes %s first", async (label) => {
    const layers = new Map<string, () => void>();
    const layer = (event: CustomEvent<{ key: string; close?: () => void }>) => {
      if (event.detail.close) layers.set(event.detail.key, event.detail.close);
      else layers.delete(event.detail.key);
    };
    window.addEventListener("orbit:back-layer", layer);
    try {
      await boot({ groups: [teamRoom()] });
      await act(async () => store.dispatch!({ type: "select", id: "g1" }));
      await openPlus();
      await click(button(label));
      expect($('[role="dialog"]')?.getAttribute("aria-label")).toBe(label);
      expect(layers.size).toBeGreaterThan(0);
      await act(async () => [...layers.values()].at(-1)!());
      expect($('[role="dialog"]')).toBeNull();
      expect(store.selectedId).toBe("g1");
    } finally {
      window.removeEventListener("orbit:back-layer", layer);
    }
  });

  it("loads older host lines on scroll-up and keeps the reader's place", async () => {
    const group = { ...teamRoom([], [line("m2", { kind: "host", id: "host", name: "Edward" }, "Recent")]), hasMore: true };
    const older = line("m1", { kind: "person", id: "p1", name: "Mina" }, "Older");
    await boot({ groups: [group], route: (call) => call.path === "/api/threads/g1-thread/messages?limit=200&before=m2" ? reply({ messages: [older], hasMore: false }) : undefined });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    const scroller = $('[data-team-room-transcript]')!;
    Object.defineProperty(scroller, "scrollHeight", { get: () => document.querySelectorAll("[data-team-room-line]").length * 400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    scroller.scrollTop = 20;
    await act(async () => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(asked("GET", "/api/threads/g1-thread/messages?limit=200&before=m2")).toHaveLength(1);
    expect([...document.querySelectorAll("[data-mid]")].map((each) => each.getAttribute("data-mid"))).toEqual(["m1", "m2"]);
    expect(scroller.scrollTop).toBe(420);
  });

  it("discards the scroll snapshot when an older page's cursor is stale", async () => {
    const person = { kind: "person", id: "p1", name: "Mina" } as const;
    const recent = line("m2", person, "Recent");
    const head = line("m0", person, "Restored history");
    let finish!: (response: Response) => void;
    await boot({ groups: [{ ...teamRoom([], [recent]), hasMore: true }], route: (call) => call.path === "/api/threads/g1-thread/messages?limit=200&before=m2" ? new Promise((resolve) => { finish = resolve; }) : undefined });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    const scroller = $('[data-team-room-transcript]')!;
    Object.defineProperty(scroller, "scrollHeight", { get: () => document.querySelectorAll("[data-team-room-line]").length * 400, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    await act(async () => scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true })));
    scroller.scrollTop = 20;
    await act(async () => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
    await act(async () => store.dispatch!({ type: "groupPatched", group: { id: "g1", messages: [head, recent], hasMore: false } }));
    scroller.scrollTop = 100;
    await act(async () => finish(reply({ messages: [line("m1", person, "Old page")], hasMore: false })));
    expect(document.querySelectorAll("[data-team-room-line]")).toHaveLength(2);
    scroller.scrollTop = 200;
    await act(async () => store.dispatch!({ type: "groupPatched", group: { id: "g1", messages: [head, recent, line("m3", person, "New line")] } }));
    expect(scroller.scrollTop).toBe(200);
  });

  it("fills a short host transcript without needing a scroll gesture", async () => {
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-team-room-transcript") ? 300 : 0; });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-team-room-transcript") ? this.querySelectorAll("[data-team-room-line]").length * 50 : 0; });
    const person = { kind: "person", id: "p1", name: "Mina" } as const;
    await boot({ groups: [{ ...teamRoom([], [line("m2", person, "Recent")]), hasMore: true }], route: (call) => call.path === "/api/threads/g1-thread/messages?limit=200&before=m2" ? reply({ messages: [line("m1", person, "Older")], hasMore: false }) : undefined });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    expect(asked("GET", "/api/threads/g1-thread/messages?limit=200&before=m2")).toHaveLength(1);
    expect(document.querySelectorAll("[data-team-room-line]")).toHaveLength(2);
    height.mockRestore();
    scroll.mockRestore();
  });

  it("keeps a room's picture on its sidebar row after a bot joins", async () => {
    await boot({ groups: [{ ...teamRoom(), memberIds: ["nova"], picture: "P".repeat(24) } as Group] });
    expect($('aside [data-room-picture] img')).not.toBeNull();
  });

  it("keeps the room picture, bell, side pane and notice after a bot joins", async () => {
    const original = line("original", { kind: "person", id: "p-mina", name: "Mina Park" }, "Standup at 10");
    const room = { ...teamRoom([], [original]), memberIds: ["nova"], picture: "P".repeat(24), notice: { entryId: "e-original", by: "host", at: 1, text: "Standup at 10" } } as Group;
    await boot({ groups: [room], route: (call) => call.method === "PATCH" ? reply({ group: room }) : undefined });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    const main = await found(() => $("main [data-room-notice]")?.closest("main"));
    expect(main.querySelector("[data-room-title] [data-room-picture] img")).not.toBeNull();
    expect(button("Turn off alerts for this room")).toBeTruthy();
    expect(button("Show and media")).toBeTruthy();
    await act(async () => { main.querySelector("[data-mid=original] [data-orbit-message-content]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })); });
    await click(button("Unpin notice"));
    expect(asked("PATCH", "/api/groups/g1").map((call) => call.body)).toEqual([{ notice: null }]);
  });

  it("creates a zero-bot room from New group with a name alone and opens it", async () => {
    const created = teamRoom();
    await boot({ route: (call) => (call.method === "POST" && call.path === "/api/groups" ? reply({ group: created }) : undefined) });
    await openPlus();
    expect(button("New team room")).toBeUndefined();
    await click(button("New group"));
    await type($<HTMLInputElement>('input[aria-label="Name your group"]'), "Design team");
    await click(button("Create"));
    expect(asked("POST", "/api/groups").map((call) => call.body)).toEqual([{ name: "Design team", hosted: true, peopleOnly: true, memberIds: [] }]);
    await vi.waitFor(() => expect($('[data-team-room="host"]')).not.toBeNull());
    expect(store.selectedId).toBe("g1");
    expect($("main")!.textContent).toContain("Design team");
  });

  it("shows only the + for bots, with no level, work, approval or hold controls in the room", async () => {
    await boot({ groups: [teamRoom()] });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    expect($('[data-team-room="host"]')).not.toBeNull();
    const main = $('[data-team-room="host"]')!;
    expect(main.querySelector("[data-orbit-composer]")).not.toBeNull();
    expect(main.querySelector("[data-room-transcript]")).toBeNull();
    const labels = [...main.querySelectorAll("button")].map((each) => each.getAttribute("aria-label") ?? each.textContent);
    expect(labels).toEqual(["Design team, Open room details", "Turn off alerts for this room", "Show and media", "Attach a file"]);
    expect(main.textContent).not.toMatch(/Nova|Find in conversation|approve|hold|level/i);
  });

  it("opens the room's Media from its header and shuts it again", async () => {
    const id = "F".repeat(24);
    // the sidebar folds for the pane, and happy-dom reports a canceled fold as unhandled
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => query === "(prefers-reduced-motion: reduce)" ? { matches: true } as MediaQueryList : matchMedia(query));
    // happy-dom has no layout, and Media draws only the cells that fit its measured pane
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("show-media-scroll") ? 412 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("show-media-scroll") ? 600 : 0; });
    await boot({ groups: [teamRoom()], route: (call) => call.path === "/api/rooms/r1/files" ? Response.json({ files: [{ id, name: "map.png", type: "image/png", bytes: 2048, at: 1, sender: "Edward" }], used: 0, capacity: 1, error: null }) : undefined });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    await click(button("Show and media"));
    await vi.waitFor(() => expect($("[data-media-grid] img")?.getAttribute("src")).toBe(`/api/rooms/r1/files/${id}/preview`));
    await click(button("Show and media"));
    await vi.waitFor(() => expect($("[data-show-media]")).toBeNull());
  });

  it("shows the room's one code to copy with no name step, lists who joined, and removes them", async () => {
    let people: Array<{ id: string; name: string }> = [];
    let code = CODE;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await boot({
      groups: [teamRoom()],
      route: (call) => {
        if (call.path === "/api/rooms/r1/invites") return reply({ code });
        if (call.method === "DELETE" && call.path === "/api/rooms/r1/people/p1") {
          people = people.filter((person) => person.id !== "p1");
          code = CODE.replace("inv_mina", "inv_next");
          return reply({ ok: true });
        }
        return undefined;
      },
    });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    const dialog = (await openDetails()).querySelector<HTMLElement>('[data-room-details-section="people"]')!;
    expect(dialog.querySelector("input, textarea")).toBeNull();
    expect(button("Invite")).toBeUndefined();
    await vi.waitFor(() => expect($("[data-team-room-code]")?.textContent).toContain(CODE));
    expect(asked("POST", "/api/rooms/r1/invites")).toHaveLength(1);
    expect(dialog.textContent).toContain("Anyone with this code can join and read this whole chat.");
    expect(dialog.textContent).toContain("No one yet.");
    await click(button("Copy"));
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect($("[data-team-room-code]")!.textContent).toContain("Copied");

    people = [{ id: "p1", name: "Mina" }, { id: "p2", name: "Joon" }];
    await act(async () => store.dispatch!({ type: "groupPatched", group: { id: "g1", room: { name: "Design team", people, joins: [] } } }));
    await vi.waitFor(() => expect(button("Remove Joon")).toBeTruthy());
    expect(document.querySelectorAll("[data-team-room-code]")).toHaveLength(1);
    expect($("[data-team-room-code]")!.textContent).toContain(CODE);
    await click(button("Remove Mina"));
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-labelledby] button')].find((candidate) => candidate.textContent === "Remove")!);
    expect(asked("DELETE", "/api/rooms/r1/people/p1")).toHaveLength(1);
    await vi.waitFor(() => expect(asked("POST", "/api/rooms/r1/invites")).toHaveLength(2));
    expect(button("Remove Mina")).toBeUndefined();
    expect(button("Remove Joon")).toBeTruthy();
    expect(asked("POST", "/api/rooms/r1/invites")).toHaveLength(2);
    expect($("[data-team-room-code]")!.textContent).toContain(code);
    await click(button("Copy"));
    expect(writeText).toHaveBeenLastCalledWith(code);
  });

  it("keeps a person listed when Remove fails", async () => {
    await boot({
      groups: [teamRoom([{ id: "p1", name: "Mina" }])],
      route: (call) => (call.method === "DELETE" ? reply({ error: "room store is busy" }, 500) : undefined),
    });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    await openDetails();
    await click(await found(() => button("Remove Mina")));
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-labelledby] button')].find((candidate) => candidate.textContent === "Remove")!);
    await vi.waitFor(() => expect($('[data-room-details] [role="alert"]')?.textContent).toBe("Wink couldn't finish that. Try again."));
    expect(button("Remove Mina")).toBeTruthy();
  });

  it("says why there's no code in one line, only once Invite is tapped", async () => {
    await boot({
      groups: [teamRoom()],
      route: (call) => (call.path === "/api/rooms/r1/invites" ? reply({ error: "phone access is off" }, 409) : undefined),
    });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    await openDetails();
    await vi.waitFor(() => expect(asked("POST", "/api/rooms/r1/invites")).toHaveLength(1));
    expect($('[data-room-details] [role="alert"]')).toBeNull();
    await click(await found(() => button("Invite")));
    await vi.waitFor(() => expect($('[data-room-details] [role="alert"]')?.textContent).toBe("Turn on Phone Access in Settings first."));
    expect($("[data-team-room-code]")).toBeNull();
  });

  it("shows the room code in Korean", async () => {
    await boot({ locale: "ko", groups: [teamRoom()], route: (call) => (call.path === "/api/rooms/r1/invites" ? reply({ code: CODE }) : undefined) });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    await openDetails("Design team, 채팅방 세부 정보 열기");
    await vi.waitFor(() => expect($("[data-team-room-code]")?.textContent).toContain(CODE));
    expect($("aside[data-room-details]")!.textContent).toContain("채팅방 세부 정보");
    expect($("aside[data-room-details]")!.textContent).toContain("초대 코드");
    expect($("aside[data-room-details]")!.textContent).toContain("이 코드가 있으면 누구나 참여해서 이 채팅 전체를 읽을 수 있어요.");
    expect(button("복사")).toBeTruthy();
  });

  it("renders text, pictures and files through the shared row and sends both kinds", async () => {
    const files = [
      { id: "P".repeat(24), name: "board.png", type: "image/png", bytes: 2048, sha256: "a" },
      { id: "D".repeat(24), name: "plan.pdf", type: "application/pdf", bytes: 4096, sha256: "b" },
    ];
    await boot({
      groups: [teamRoom([{ id: "p1", name: "Mina" }], [
        line("m1", { kind: "host", id: "host", name: "Edward" }, "Morning"),
        line("m2", { kind: "person", id: "p1", name: "Mina" }, "Here it is", files),
      ])],
      route: (call) => {
        if (call.path.startsWith("/api/rooms/r1/files?")) return reply({ file: { id: "U".repeat(24) } });
        if (call.path === "/api/rooms/r1/send") return reply({ ok: true });
        return undefined;
      },
    });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    const rows = document.querySelectorAll("[data-team-room-line]");
    expect([...rows].map((row) => row.getAttribute("data-team-room-line"))).toEqual(["mine", "theirs"]);
    expect($('[data-team-room="host"]')!.textContent).toContain("Mina");
    expect($<HTMLImageElement>('[data-team-room-line="theirs"] img')!.getAttribute("src")).toBe(`/api/rooms/r1/files/${"P".repeat(24)}/preview`);
    const download = $<HTMLAnchorElement>('[data-team-room-line="theirs"] a[download]')!;
    expect(download.getAttribute("href")).toBe(`/api/rooms/r1/files/${"D".repeat(24)}`);
    expect(download.getAttribute("download")).toBe("plan.pdf");
    expect(download.textContent).toContain("plan.pdf");
    expect(download.textContent).toContain("4.0 KB");

    const box = $<HTMLTextAreaElement>('[data-team-room="host"] textarea')!;
    await type(box, "hello");
    await enter(box);
    await vi.waitFor(() => expect(asked("POST", "/api/rooms/r1/send")).toHaveLength(1));
    expect(asked("POST", "/api/rooms/r1/send")[0]!.body).toMatchObject({ text: "hello" });

    const picker = $<HTMLInputElement>('[data-team-room="host"] input[type="file"]:not([data-room-picture-input])')!;
    const picture = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [picture], configurable: true });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("Send message"));
    await vi.waitFor(() => expect(asked("POST", "/api/rooms/r1/send")).toHaveLength(2));
    expect(calls.find((call) => call.path.startsWith("/api/rooms/r1/files?"))!.path).toContain("name=shot.png");
    expect(asked("POST", "/api/rooms/r1/send")[1]!.body).toMatchObject({ text: "", fileIds: ["U".repeat(24)] });
  });

  it("keeps the newest line in view when a picture loads after it", async () => {
    const observers: Array<{ callback: () => void; targets: Element[] }> = [];
    vi.stubGlobal("ResizeObserver", class {
      targets: Element[] = [];
      constructor(public callback: () => void) { observers.push(this); }
      observe(target: Element) { this.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
    await boot({ groups: [teamRoom([], [line("m1", { kind: "host", id: "host", name: "Edward" }, "Morning")])] });
    await act(async () => store.dispatch!({ type: "select", id: "g1" }));
    const scroller = $('[data-team-room-transcript]')!;
    const pins = observers.filter((observer) => observer.targets.includes(scroller));
    expect(pins).not.toHaveLength(0);
    Object.defineProperty(scroller, "scrollHeight", { value: 900, configurable: true });
    await act(async () => pins.forEach((observer) => observer.callback()));
    expect(scroller.scrollTop).toBe(900);
  });
});

describe("Team rooms for a teammate", () => {
  it("joins the moment a valid code is pasted, with no Enter and no button", async () => {
    let answer!: (response: Response) => void;
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [] });
        if (call.path === "/api/joined/join") return new Promise<Response>((resolve) => { answer = resolve; });
        if (call.path === "/api/joined/rooms/r9") return reply({ room: { ...joinedView("joined", "live"), entries: joinedEntries } });
        return undefined;
      },
    });
    await act(async () => store.dispatch!({ type: "configStatus", config: { features: {}, profile: { name: "Mina" } } as never }));
    await openPlus();
    await click(button("Join with code"));
    const box = $<HTMLInputElement>('input[aria-label="Room code 1"]')!;
    expect(document.querySelectorAll('[role="dialog"] button')).toHaveLength(0);
    await paste(box, `  ${CODE}\n`);
    expect(asked("POST", "/api/joined/join").map((call) => call.body)).toEqual([{ code: CODE }]);
    expect($('[role="dialog"]')!.textContent).toContain("Joining...");
    await act(async () => answer(reply({ room: joinedView("joined", "connecting") })));
    await vi.waitFor(() => expect($('[data-team-room="joined"]')).not.toBeNull());
    expect(store.selectedId).toBe("joined:r9");
    expect($('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect($('[data-team-room="joined"]')!.getAttribute("data-team-room-phase")).toBe("live"));
    expect($("[data-joined-room-row]")!.textContent).toContain("Design team");
  });

  it("asks for a name before joining when there is no profile name, and saves it", async () => {
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [] });
        if (call.path === "/api/config" && call.method === "PUT") return reply({ features: {}, profile: { name: "Mina" } });
        if (call.path === "/api/joined/join") return reply({ room: joinedView("joined", "connecting") });
        if (call.path === "/api/joined/rooms/r9") return reply({ room: { ...joinedView("joined", "live"), entries: joinedEntries } });
        return undefined;
      },
    });
    await openPlus();
    await click(button("Join with code"));
    const name = () => $<HTMLInputElement>('[role="dialog"] input[aria-label="Your name"]');
    expect(name()?.value).toBe("");
    expect(document.activeElement).toBe(name());
    await type(name(), "  @Mina\n");
    await paste($<HTMLInputElement>('input[aria-label="Room code 1"]'), CODE);
    await vi.waitFor(() => expect(asked("POST", "/api/joined/join")).toHaveLength(1));
    expect(calls.filter((call) => call.method === "PUT" || call.path === "/api/joined/join").map((call) => [call.path, call.body]))
      .toEqual([["/api/config", { profile: { name: "Mina" } }], ["/api/joined/join", { code: CODE }]]);
    await vi.waitFor(() => expect(store.selectedId).toBe("joined:r9"));
  });

  it("never fills the name box with the PC name, so a pasted code asks for a name", async () => {
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [] });
        if (call.path === "/api/joined/name") return reply({ name: "DESKTOP-4F2K" });
        if (call.path === "/api/joined/join") return reply({ room: joinedView("joined", "connecting") });
        return undefined;
      },
    });
    await openPlus();
    await click(button("Join with code"));
    await paste($<HTMLInputElement>('input[aria-label="Room code 1"]'), CODE);
    await vi.waitFor(() => expect($('[role="dialog"] [role="alert"]')?.textContent).toBe("Add your name first."));
    expect($<HTMLInputElement>('[role="dialog"] input[aria-label="Your name"]')!.value).toBe("");
    expect(calls.some((call) => call.method === "PUT" || call.path === "/api/joined/join")).toBe(false);
  });

  it("will not join with a blank name, and Enter on the name retries", async () => {
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [] });
        if (call.path === "/api/config" && call.method === "PUT") return reply({ features: {}, profile: { name: "Mina" } });
        if (call.path === "/api/joined/join") return reply({ room: joinedView("joined", "connecting") });
        return undefined;
      },
    });
    await openPlus();
    await click(button("Join with code"));
    const name = $<HTMLInputElement>('[role="dialog"] input[aria-label="Your name"]');
    await type(name, " @ ");
    await paste($<HTMLInputElement>('input[aria-label="Room code 1"]'), CODE);
    await vi.waitFor(() => expect($('[role="dialog"] [role="alert"]')?.textContent).toBe("Add your name first."));
    expect(asked("POST", "/api/joined/join")).toHaveLength(0);
    await type(name, "Mina");
    await enter(name);
    await vi.waitFor(() => expect(asked("POST", "/api/joined/join")).toHaveLength(1));
    expect(asked("PUT", "/api/config").map((call) => call.body)).toEqual([{ profile: { name: "Mina" } }]);
  });

  it("joins under the profile name without asking for one", async () => {
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [] });
        if (call.path === "/api/joined/join") return reply({ room: joinedView("joined", "connecting") });
        return undefined;
      },
    });
    await act(async () => store.dispatch!({ type: "configStatus", config: { features: {}, profile: { name: "Mina" } } as never }));
    await openPlus();
    await click(button("Join with code"));
    expect($('[role="dialog"] input[aria-label="Your name"]')).toBeNull();
    await paste($<HTMLInputElement>('input[aria-label="Room code 1"]'), CODE);
    await vi.waitFor(() => expect(asked("POST", "/api/joined/join")).toHaveLength(1));
    expect(calls.some((call) => call.path === "/api/config" && call.method === "PUT" || call.path === "/api/joined/name")).toBe(false);
  });

  it("shows one short line for a bad code and joins nothing", async () => {
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [] });
        if (call.path === "/api/joined/join") return reply({ error: "wrong-secret" }, 401);
        return undefined;
      },
    });
    await act(async () => store.dispatch!({ type: "configStatus", config: { features: {}, profile: { name: "Mina" } } as never }));
    await openPlus();
    await click(button("Join with code"));
    const box = $<HTMLInputElement>('input[aria-label="Room code 1"]')!;
    await paste(box, "hello there");
    expect($('[role="dialog"] [role="alert"]')!.textContent).toBe("That code doesn't work.");
    expect(asked("POST", "/api/joined/join")).toHaveLength(0);
    await paste(box, CODE);
    await vi.waitFor(() => expect(asked("POST", "/api/joined/join")).toHaveLength(1));
    await vi.waitFor(() => expect($('[role="dialog"] [role="alert"]')?.textContent).toBe("That code doesn't work."));
    expect(store.selectedId).not.toBe("joined:r9");
  });

  it("walks connecting, live, offline, removed and left, sending only while live", async () => {
    let view = joinedView("joined", "connecting");
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [view] });
        if (call.path === "/api/joined/rooms/r9") return reply({ room: { ...view, entries: joinedEntries } });
        if (call.path === "/api/joined/rooms/r9/send") return reply({ ok: true });
        if (call.path === "/api/joined/rooms/r9/leave") {
          view = joinedView("left", null);
          return reply({ ok: true });
        }
        return undefined;
      },
    });
    await act(async () => store.dispatch!({ type: "select", id: "joined:r9" }));
    const main = () => $('[data-team-room="joined"]')!;
    const phase = () => $('[data-team-room="joined"]')?.getAttribute("data-team-room-phase");
    const status = () => main().querySelector('[role="status"]')?.textContent;
    await vi.waitFor(() => expect(phase()).toBe("connecting"));
    expect(status()).toBe("Connecting...");
    expect(main().querySelector("textarea")).not.toBeNull();

    view = joinedView("joined", "live");
    await joinedFrame("r9");
    await vi.waitFor(() => expect(phase()).toBe("live"));
    expect(status()).toBeUndefined();
    const box = main().querySelector("textarea")!;
    await type(box, "on my way");
    await enter(box);
    await vi.waitFor(() => expect(asked("POST", "/api/joined/rooms/r9/send")).toHaveLength(1));
    expect([...main().querySelectorAll("[data-team-room-line]")].map((row) => row.getAttribute("data-team-room-line"))).toEqual(["theirs", "mine"]);
    expect(main().querySelector("img")!.getAttribute("src")).toBe(`/api/joined/rooms/r9/files/${"F".repeat(24)}/preview`);
    expect(main().querySelector("a[download]")!.getAttribute("href")).toBe(`/api/joined/rooms/r9/files/${"G".repeat(24)}`);

    view = joinedView("joined", "offline");
    await joinedFrame("r9");
    await vi.waitFor(() => expect(phase()).toBe("offline"));
    expect(status()).toBe("Unavailable. Edward is offline.");
    await type(main().querySelector("textarea")!, "held");
    await enter(main().querySelector("textarea")!);
    expect(asked("POST", "/api/joined/rooms/r9/send")).toHaveLength(1);

    view = joinedView("removed", null);
    await joinedFrame("r9");
    await vi.waitFor(() => expect(phase()).toBe("removed"));
    expect(status()).toBe("You were removed from this room.");
    expect(button("Leave")).toBeUndefined();

    view = joinedView("joined", "live");
    await joinedFrame("r9");
    await vi.waitFor(() => expect(phase()).toBe("live"));
    await openDetails();
    await click(await found(() => button("Leave")));
    expect($('[role="dialog"]')!.textContent).toContain("Leave Design team?");
    await click([...document.querySelectorAll('[role="dialog"] button')].find((each) => each.textContent === "Leave"));
    expect(asked("POST", "/api/joined/rooms/r9/leave")).toHaveLength(1);
    await joinedFrame("r9");
    await vi.waitFor(() => expect(phase()).toBe("left"));
    expect(status()).toBe("You left this room.");
    expect(asked("POST", "/api/joined/rooms/r9/send")).toHaveLength(1);
  });

  it("never offers bot features or owner screens in a joined room", async () => {
    await boot({
      route: (call) => {
        if (call.path === "/api/joined/rooms") return reply({ rooms: [joinedView("joined", "live")] });
        if (call.path === "/api/joined/rooms/r9") return reply({ room: { ...joinedView("joined", "live"), entries: joinedEntries } });
        return undefined;
      },
    });
    await act(async () => store.dispatch!({ type: "select", id: "joined:r9" }));
    await vi.waitFor(() => expect($('[data-team-room="joined"]')?.getAttribute("data-team-room-phase")).toBe("live"));
    const main = $('[data-team-room="joined"]')!;
    expect(main.querySelector("[data-orbit-composer]")).not.toBeNull();
    const labels = [...main.querySelectorAll("button")].filter((each) => !each.closest("[data-mid]")).map((each) => each.getAttribute("aria-label") ?? each.textContent);
    expect(labels.filter((label) => !label?.startsWith("Preview attached image"))).toEqual(["Design team, Open room details", "Turn off alerts for this room", "Attach a file"]);
    expect(main.textContent).not.toMatch(/Nova|Settings|Manage members|Find in conversation|approve|model/i);
    const details = await openDetails();
    expect(details.textContent).toContain("Edward");
    expect(details.textContent).toContain("You");
    expect(details.textContent).not.toMatch(/Nova|Invite|New bot/);
    expect(button("Remove")).toBeUndefined();
    await click(button("Change your name"));
    const input = $<HTMLInputElement>("aside[data-room-details] input")!;
    expect(document.activeElement).toBe(input);
    await joinedFrame("r9");
    expect(document.activeElement).toBe(input);
    expect(calls.some((call) => call.path.startsWith("/api/rooms/"))).toBe(false);
    await act(async () => store.dispatch!({ type: "hydrate", bots: [nova], groups: [], botsUnreadable: false, computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } } as never));
    expect(store.selectedId).toBe("joined:r9");
  });

  it("speaks Korean", async () => {
    await boot({ locale: "ko", route: (call) => (call.path === "/api/joined/rooms" ? reply({ rooms: [] }) : undefined) });
    await act(async () => store.dispatch!({ type: "configStatus", config: { features: {}, profile: { name: "Mina" } } as never }));
    await openPlus();
    expect(button("새 팀 채팅방")).toBeUndefined();
    await click(button("코드로 참여"));
    const box = $<HTMLInputElement>('input[aria-label="채팅방 코드 1"]')!;
    await paste(box, "아무거나");
    expect($('[role="dialog"] [role="alert"]')!.textContent).toBe("사용할 수 없는 코드예요.");
  });
});
