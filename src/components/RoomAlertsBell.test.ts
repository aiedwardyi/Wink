import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { I18nProvider, persistPreference } from "@/lib/i18n";
import { ROOM_ALERTS_OFF_KEY, roomAlertsOff, setRoomAlerts } from "@/lib/room-alerts";
import type { WebPushState } from "@/lib/web-push";
import { RoomAlertsBell } from "./RoomAlertsBell";

const mock = vi.hoisted(() => ({
  phone: true,
  supported: true,
  read: vi.fn<() => Promise<WebPushState>>(),
  enable: vi.fn<() => Promise<WebPushState>>(),
  sync: vi.fn<() => Promise<void>>(),
  dispatch: vi.fn(),
  state: { error: null as string | null },
}));
vi.mock("@/lib/use-phone-swipe", () => ({ useIsPhone: () => mock.phone }));
vi.mock("@/lib/web-push", () => ({
  webPushSupported: () => mock.supported,
  readWebPushState: mock.read,
  enableWebPush: mock.enable,
  syncWebPushRooms: mock.sync,
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: mock.state, dispatch: mock.dispatch }) }));

let root: Root;
let frames: FrameRequestCallback[];
const button = () => document.querySelector<HTMLButtonElement>("[data-room-bell]")!;
const on = () => button().getAttribute("data-room-bell");
const tap = () => act(async () => button().click());
const render = (chat = "room") => act(async () => root.render(createElement(I18nProvider, null, createElement(RoomAlertsBell, { chat }))));
const paint = () => act(async () => {
  const callbacks = frames.splice(0);
  for (const callback of callbacks) callback(0);
});
const settle = async () => { await paint(); await paint(); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  persistPreference("en");
  mock.phone = true;
  mock.supported = true;
  mock.read.mockReset().mockResolvedValue("off");
  mock.enable.mockReset().mockResolvedValue("on");
  mock.sync.mockReset().mockResolvedValue();
  mock.state.error = null;
  mock.dispatch.mockReset().mockImplementation((action: { message: string | null }) => { mock.state.error = action.message; });
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(["off", "blocked"] as const)("shows on immediately while push is %s, then keeps the enabled result", async (state) => {
  const request = deferred<WebPushState>();
  mock.read.mockResolvedValue(state);
  mock.enable.mockReturnValue(request.promise);
  await render();
  expect(on()).toBe("off");
  await tap();
  expect(on()).toBe("on");
  expect(button().getAttribute("aria-pressed")).toBe("true");
  expect(button().getAttribute("aria-label")).toBe("Turn off alerts for this group");
  expect(mock.enable).toHaveBeenCalledOnce();
  await act(async () => request.resolve("on"));
  await settle();
  expect(on()).toBe("on");
  expect(roomAlertsOff()).not.toContain("room");
  await tap();
  expect(on()).toBe("off");
  expect(button().getAttribute("aria-pressed")).toBe("false");
  expect(roomAlertsOff()).toContain("room");
  expect(mock.enable).toHaveBeenCalledOnce();
});

it.each(["en", "ko"] as const)("paints an immediately blocked attempt before reverting with the existing %s reason", async (locale) => {
  persistPreference(locale);
  mock.read.mockResolvedValue("blocked");
  mock.enable.mockResolvedValue("blocked");
  await render();
  await tap();
  expect(on()).toBe("on");
  await paint();
  expect(on()).toBe("on");
  await paint();
  expect(on()).toBe("off");
  expect(roomAlertsOff()).toContain("room");
  expect(mock.dispatch).toHaveBeenCalledWith({ type: "error", message: locale === "en"
    ? "Blocked. Allow notifications in browser settings."
    : "차단됨. 브라우저 설정에서 알림을 허용하세요." });
});

it.each(["off", "unsupported", "error"] as const)("reverts a %s result with the existing failure reason", async (result) => {
  const request = deferred<WebPushState>();
  mock.enable.mockReturnValue(request.promise);
  await render();
  await tap();
  expect(on()).toBe("on");
  await act(async () => result === "error" ? request.reject(new Error("subscription failed")) : request.resolve(result));
  await settle();
  expect(on()).toBe("off");
  expect(roomAlertsOff()).toContain("room");
  expect(mock.dispatch).toHaveBeenCalledWith({ type: "error", message: result === "unsupported"
    ? "Open Wink in your phone's browser to turn these on."
    : "Could not turn on phone notifications." });
});

it.each(["on", "blocked"] as const)("keeps a later off tap when the pending request returns %s", async (result) => {
  const request = deferred<WebPushState>();
  mock.enable.mockReturnValue(request.promise);
  await render();
  await tap();
  expect(on()).toBe("on");
  await tap();
  expect(on()).toBe("off");
  await act(async () => request.resolve(result));
  await settle();
  expect(on()).toBe("off");
  expect(roomAlertsOff()).toContain("room");
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it("shares the pending permission request across rapid on/off/on taps", async () => {
  const request = deferred<WebPushState>();
  mock.enable.mockReturnValue(request.promise);
  await render();
  await tap();
  await tap();
  await tap();
  expect(on()).toBe("on");
  expect(mock.enable).toHaveBeenCalledOnce();
  await act(async () => request.resolve("on"));
  await settle();
  expect(on()).toBe("on");
});

it("toggles an existing push subscription without requesting permission again", async () => {
  mock.read.mockResolvedValue("on");
  await render();
  expect(on()).toBe("on");
  await tap();
  expect(on()).toBe("off");
  await tap();
  expect(on()).toBe("on");
  expect(mock.enable).not.toHaveBeenCalled();
  expect(mock.sync).toHaveBeenCalledTimes(2);
});

it("ignores a late initial read after a tap", async () => {
  const read = deferred<WebPushState>();
  mock.read.mockReturnValue(read.promise);
  setRoomAlerts("room", false);
  await render();
  await tap();
  await settle();
  await act(async () => read.resolve("off"));
  expect(on()).toBe("on");
});

it("does not apply a failed attempt to a different room", async () => {
  const request = deferred<WebPushState>();
  mock.enable.mockReturnValue(request.promise);
  await render();
  await tap();
  await render("other");
  await act(async () => request.resolve("blocked"));
  await settle();
  expect(mock.dispatch).not.toHaveBeenCalled();
  expect(roomAlertsOff()).not.toContain("other");
});

it("ignores a failed permission request after unmount", async () => {
  const request = deferred<WebPushState>();
  mock.enable.mockReturnValue(request.promise);
  await render();
  await tap();
  await act(async () => root.render(null));
  await act(async () => request.reject(new Error("subscription failed")));
  await settle();
  expect(mock.dispatch).not.toHaveBeenCalled();
});

it.each([false, true])("toggles local alerts without push when desktop is %s", async (desktop) => {
  mock.phone = !desktop;
  mock.supported = desktop;
  await render();
  expect(on()).toBe("on");
  await tap();
  expect(on()).toBe("off");
  expect(JSON.parse(localStorage.getItem(ROOM_ALERTS_OFF_KEY)!)).toEqual(["room"]);
  await tap();
  expect(on()).toBe("on");
  expect(mock.enable).not.toHaveBeenCalled();
  expect(mock.sync).not.toHaveBeenCalled();
});

it.each(["pointerup", "pointercancel", "pointerout"])("clears touch feedback on %s without changing the room", async (type) => {
  await render();
  const pointer = (name: string) => {
    const event = new Event(name, { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    button().dispatchEvent(event);
  };
  await act(async () => pointer("pointerdown"));
  expect(button().hasAttribute("data-down")).toBe(true);
  await act(async () => pointer(type));
  expect(button().hasAttribute("data-down")).toBe(false);
  expect(on()).toBe("off");
  expect(mock.enable).not.toHaveBeenCalled();
});

it("keeps mouse press feedback in the existing desktop hover style", async () => {
  mock.phone = false;
  await render();
  const event = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  await act(async () => button().dispatchEvent(event));
  expect(button().hasAttribute("data-down")).toBe(false);
});

it.each([false, true])("clears its refusal on retry while preserving an unrelated error: %s", async (unrelated) => {
  mock.read.mockResolvedValue("blocked");
  mock.enable.mockResolvedValueOnce("blocked").mockResolvedValueOnce("on");
  await render();
  await tap();
  await settle();
  expect(mock.state.error).toBe("Blocked. Allow notifications in browser settings.");
  if (unrelated) mock.state.error = "Another failure";
  await tap();
  expect(on()).toBe("on");
  await settle();
  expect(on()).toBe("on");
  expect(mock.state.error).toBe(unrelated ? "Another failure" : null);
});
