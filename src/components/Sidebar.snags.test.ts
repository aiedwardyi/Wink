import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";
import { noteJoinedRoom } from "@/lib/joined-rooms";
import { SIDEBAR_ORDER_KEY } from "@/lib/sidebar-preferences";
import { LONG_PRESS_MS } from "@/lib/use-touch-drag";
import { StoreProvider } from "@/state/store";
import { Sidebar } from "./Sidebar";

const joined = vi.hoisted(() => ({ needsCode: false, rooms: [{
  roomId: "r9", status: "joined", link: "live", me: { id: "me", name: "Mina" },
  state: { roomName: "함께 만드는 아주 긴 디자인 프로젝트 대화방", host: "Studio", people: [] },
}] }));
vi.mock("@/lib/joined-rooms", () => ({ useJoinedRooms: () => joined.rooms, useLoadedJoinedRooms: () => joined.rooms, noteJoinedRoom: vi.fn(), forgetJoinedRoom: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => null, useManualCheck: () => ({ acknowledged: true, check: vi.fn() }) }));
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });

class FakeEventSource {
  static current: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() { FakeEventSource.current = this; }
}

let root: Root | null = null;
const calls: Array<{ path: string; method: string; body: unknown }> = [];
const bot = (id: string) => ({ id, threadId: `${id}-thread`, name: id, messages: [], modelSelection: { instanceId: "", model: "" } });
const group = { id: "host", threadId: "host-thread", name: "Design team", memberIds: [], messages: [], hosted: { roomId: "r1" }, room: { name: "Design team", people: [] }, defaultResponder: { kind: "everyone" }, bulletin: "", createdAt: 0 };

async function mount() {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method) calls.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith("/api/bots?")) return new Response(JSON.stringify({ bots: [bot("first"), bot("last")], groups: [group] }));
    if (path === "/api/rooms/r1/invites") return new Response(JSON.stringify({ code: "fixture-code" }));
    if (path === "/api/joined/rooms/r9/rejoin") {
      if (joined.needsCode && !JSON.parse(String(init?.body ?? "{}"))?.code) return new Response(JSON.stringify({ error: "no-saved-code" }), { status: 409 });
      joined.needsCode = false;
      return new Response(JSON.stringify({ room: { ...joined.rooms[0], status: "joined", link: "live" } }));
    }
    if (path === "/api/joined/rooms/r9" && init?.method === "DELETE") return new Response(JSON.stringify({ removed: true }));
    if (path.startsWith("/api/groups/") && init?.method === "PATCH") return new Response(JSON.stringify({ group: { ...group, ...JSON.parse(String(init.body)) } }));
    return new Response("{}", { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: vi.fn() })))));
  await act(async () => FakeEventSource.current.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
  await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="first"]')).not.toBeNull());
  return host;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-sidebar-row-id="${id}"]`)!;
const fireDrag = (target: Element, type: string) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => "", setData: vi.fn() } });
  target.dispatchEvent(event);
};
const menu = () => document.querySelector<HTMLElement>("[data-room-menu]:not([data-closing])");
async function context(id: string) {
  const target = row(id) ?? document.querySelector<HTMLElement>("[data-joined-room-row]")!;
  await act(async () => target.querySelector("button")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 })));
  expect(menu()).not.toBeNull();
  return menu()!;
}
const labels = (target: Element) => [...target.querySelectorAll("button")].map((button) => button.textContent?.trim());

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  persistPreference("en");
  calls.length = 0;
  joined.rooms[0].status = "joined";
  joined.needsCode = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["host", "joined:r9"])("drags %s between bot rows and keeps the order after remount and updates", async (id) => {
  await mount();
  const source = row(id) ?? document.querySelector<HTMLElement>("[data-joined-room-row]")!;
  expect(source.getAttribute("draggable")).toBe("true");
  const target = id === "host" ? "first" : "last";
  await act(async () => fireDrag(source, "dragstart"));
  await act(async () => fireDrag(row(target), "dragover"));
  await act(async () => fireDrag(row(target), "drop"));
  const ids = () => [...document.querySelectorAll("[data-sidebar-row-id]")].map((item) => item.getAttribute("data-sidebar-row-id"));
  const before = ids();
  expect(before.indexOf(id)).toBe(before.indexOf(target) + (id === "host" ? 1 : -1));
  expect(localStorage.getItem(SIDEBAR_ORDER_KEY)).toContain(id);
  await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  await mount();
  expect(ids()).toEqual(before);
  await act(async () => FakeEventSource.current.onmessage?.({ data: JSON.stringify({ kind: "group", group: { ...group, messages: [{ id: "new", role: "user", kind: "text", text: "new message", at: Date.now() }] } }), lastEventId: "c1" }));
  expect(ids()).toEqual(before);
});

it.each([
  ["en", "host", ["Pin", "Rename Design team", "Move to section", "People", "Copy", "Delete group"]],
  ["en", "joined:r9", ["Pin", "Move to section", "Leave"]],
  ["ko", "host", ["고정", "Design team 이름 바꾸기", "분류로 이동", "참여자", "복사", "그룹 삭제"]],
] as const)("opens the %s menu for %s", async (locale, id, expected) => {
  persistPreference(locale);
  await mount();
  expect(labels(await context(id))).toEqual(expected);
});

it.each(["host", "joined:r9"])("opens %s menu after a stationary touch hold", async (id) => {
  await mount();
  const target = row(id) ?? document.querySelector<HTMLElement>("[data-joined-room-row]")!;
  vi.useFakeTimers();
  vi.spyOn(document, "elementFromPoint").mockReturnValue(target.querySelector("button"));
  const touch = new Event("touchstart", { bubbles: true });
  Object.defineProperty(touch, "touches", { value: [{ clientX: 40, clientY: 80 }] });
  await act(async () => target.querySelector("button")!.dispatchEvent(touch));
  await act(async () => { await vi.advanceTimersByTimeAsync(LONG_PRESS_MS + 20); });
  await act(async () => target.querySelector("button")!.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true })));
  expect(menu()).not.toBeNull();
});

async function choose(target: Element, label: string) {
  const button = [...target.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("keeps joined pin and section local through remount, then unpins in its saved slot", async () => {
  await mount();
  await choose(await context("joined:r9"), "Move to section");
  const picker = document.querySelector<HTMLElement>("[data-section-picker]:not([data-closing])")!;
  const input = picker.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Studio");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => picker.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(row("joined:r9").closest('[data-sidebar-section-id="section:Studio"]')).not.toBeNull();
  await choose(await context("joined:r9"), "Pin");
  expect(row("joined:r9").closest('[data-sidebar-priority-tier="pinned"]')).not.toBeNull();
  await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  await mount();
  expect(row("joined:r9").closest('[data-sidebar-priority-tier="pinned"]')).not.toBeNull();
  await choose(await context("joined:r9"), "Unpin");
  expect(row("joined:r9").closest('[data-sidebar-section-id="section:Studio"]')).not.toBeNull();
  expect(calls.filter((call) => call.path.includes("joined:r9"))).toEqual([]);
});

it("copies the hosted invite and opens its existing People sheet", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await mount();
  await choose(await context("host"), "Copy");
  expect(writeText).toHaveBeenCalledWith("fixture-code");
  await choose(await context("host"), "People");
  expect(document.querySelector('[role="dialog"][aria-label="People"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"][aria-label="People"]')!.closest("aside")).toBeNull();
  expect(document.querySelector("[data-team-room-code]")?.textContent).toContain("fixture-code");
});

it("requires the existing leave confirmation before posting", async () => {
  await mount();
  await choose(await context("joined:r9"), "Leave");
  expect(calls.filter((call) => call.path.endsWith("/leave"))).toEqual([]);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await choose(dialog, "Leave");
  expect(calls).toContainEqual({ path: "/api/joined/rooms/r9/leave", method: "POST", body: undefined });
});

it.each([
  ["en", "Leave", "Wink couldn't finish that. Try again."],
  ["ko", "나가기", "Wink가 작업을 마치지 못했어요. 다시 시도해 주세요."],
] as const)("keeps a failed leave open for retry in %s", async (locale, label, error) => {
  persistPreference(locale);
  await mount();
  const fetch = vi.mocked(globalThis.fetch);
  const original = fetch.getMockImplementation()!;
  let finish!: (response: Response) => void;
  fetch.mockImplementation((...args) => String(args[0]).endsWith("/leave") ? new Promise<Response>((resolve) => { finish = resolve; }) : original(...args));
  await choose(await context("joined:r9"), label);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await choose(dialog, label);
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect([...dialog.querySelectorAll("button")].find((button) => button.textContent === label)!.disabled).toBe(true);
  await act(async () => finish(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(error);
  await choose(dialog, label);
  const room = { ...joined.rooms[0], status: "left", link: null };
  await act(async () => finish(new Response(JSON.stringify({ room }))));
  expect(noteJoinedRoom).toHaveBeenCalledWith(room);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each(["left", "removed"])("shows the %s room recovery menu and confirms local removal", async (status) => {
  joined.rooms[0].status = status;
  await mount();
  const target = await context("joined:r9");
  expect(labels(target)).toEqual(["Pin", "Move to section", ...(status === "left" ? ["Rejoin"] : []), "Remove from list"]);
  await choose(target, "Remove from list");
  expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
  await choose(document.querySelector('[role="dialog"]')!, "Remove from list");
  expect(calls).toContainEqual({ path: "/api/joined/rooms/r9", method: "DELETE", body: undefined });
});

it("rejoins a left room without a code field and opens it", async () => {
  joined.rooms[0].status = "left";
  await mount();
  await choose(await context("joined:r9"), "Rejoin");
  expect(calls).toContainEqual({ path: "/api/joined/rooms/r9/rejoin", method: "POST", body: undefined });
  expect(document.querySelector('input[aria-label="Paste a room code"]')).toBeNull();
  expect(row("joined:r9").querySelector("button")?.className).toContain("bg-raised");
});

it.each([
  ["en", "Rejoin", "Paste this room's code once. This PC will remember it."],
  ["ko", "다시 참여", "이 채팅방의 코드를 한 번만 붙여 넣어 주세요. 이 PC에 저장돼요."],
] as const)("asks once for an old copy's code in %s", async (locale, label, hint) => {
  persistPreference(locale);
  joined.rooms[0].status = "left";
  joined.needsCode = true;
  await mount();
  await choose(await context("joined:r9"), label);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog!.textContent).toContain(hint);
  const code = `wkr1:studio.example.test:invite.wki_${"A".repeat(43)}`;
  const input = dialog!.querySelector("input")!;
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => code } });
  await act(async () => input.dispatchEvent(paste));
  expect(calls).toContainEqual({ path: "/api/joined/rooms/r9/rejoin", method: "POST", body: { code } });
  await choose(await context("joined:r9"), label);
  expect(document.querySelector('[role="dialog"]:not([inert]) input')).toBeNull();
  expect(calls.at(-1)).toEqual({ path: "/api/joined/rooms/r9/rejoin", method: "POST", body: undefined });
});

it.each(["en", "ko"] as const)("replaces a rejected saved code in %s", async (locale) => {
  persistPreference(locale);
  joined.rooms[0].status = "left";
  await mount();
  const fetch = vi.mocked(globalThis.fetch);
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation((...args) => String(args[0]).endsWith("/rejoin") && !args[1]?.body
    ? Promise.resolve(new Response(JSON.stringify({ error: "bad-code" }), { status: 400 })) : original(...args));
  await choose(await context("joined:r9"), locale === "en" ? "Rejoin" : "다시 참여");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  const code = `wkr1:studio.example.test:invite.wki_${"B".repeat(43)}`;
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => code } });
  await act(async () => dialog!.querySelector("input")!.dispatchEvent(paste));
  expect(calls.at(-1)).toEqual({ path: "/api/joined/rooms/r9/rejoin", method: "POST", body: { code } });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
