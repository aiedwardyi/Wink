// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Action } from "@/state/store-types";
import { scrollToFollowBottom } from "./bottom-follow";
import { noteDispatch, reportChatSwitch, watchDeadTaps } from "./chat-switch-diag";

function someNonUserPath(action: Action) {
  noteDispatch(action);
}

describe("chat switch diag", () => {
  it("names the action and the code that dispatched a switch", () => {
    const send = vi.fn();
    const action: Action = { type: "select", id: "marketing" };
    someNonUserPath(action);
    reportChatSwitch(action, "wink", "marketing", send);
    expect(send).toHaveBeenCalledTimes(1);
    const line = send.mock.calls[0]![0];
    expect(line).toMatchObject({ from: "wink", to: "marketing", action: "select", desktop: false, visibility: "visible" });
    expect(line.event).toBeUndefined();
    expect(line.caller.join("\n")).toContain("someNonUserPath");
  });

  it("records the input event a switch ran under", () => {
    const send = vi.fn();
    const action: Action = { type: "select", id: "marketing" };
    // a browser sets window.event while a handler runs; happy-dom does not
    Object.defineProperty(window, "event", { value: new MouseEvent("click"), configurable: true });
    noteDispatch(action);
    Reflect.deleteProperty(window, "event");
    reportChatSwitch(action, "wink", "marketing", send);
    expect(send.mock.calls[0]![0]).toMatchObject({ event: "click" });
  });

  it("names a switch that no select caused, once per action", () => {
    const send = vi.fn();
    const action: Action = { type: "deleteBot", botId: "wink" };
    reportChatSwitch(action, "wink", "marketing", send);
    reportChatSwitch(action, "wink", "marketing", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ action: "deleteBot" });
    expect(send.mock.calls[0]![0].caller).toBeUndefined();
  });

  it("logs a switch that leaves no chat open", () => {
    const send = vi.fn();
    const action: Action = { type: "deleteBot", botId: "wink" };
    reportChatSwitch(action, "wink", undefined, send);
    expect(send.mock.calls[0]![0]).toMatchObject({ from: "wink", to: "", action: "deleteBot" });
  });
});

let now = 0;

function stamp<E extends Event>(event: E): E {
  Object.defineProperty(event, "timeStamp", { value: now });
  return event;
}

function touch(type: string, target: Element, x = 40, y = 40) {
  const event = stamp(new Event(type, { bubbles: true, cancelable: true }));
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
  Object.defineProperty(event, "changedTouches", { value: [point] });
  target.dispatchEvent(event);
}

function tap(target: Element, live: Element | boolean, x = 40, y = 40) {
  touch("touchstart", target, x, y);
  touch("touchend", target, x, y);
  if (live) (live === true ? target : live).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  vi.advanceTimersByTime(700);
  now += 700;
}

function scroll(target: Element) {
  target.dispatchEvent(stamp(new Event("scroll")));
}

describe("dead tap catcher", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function chat() {
    vi.useFakeTimers();
    const zone = document.createElement("div");
    const stage = document.createElement("div");
    const page = document.createElement("div");
    page.dataset.phoneChatPage = "wink";
    const row = document.createElement("p");
    page.append(row);
    stage.append(page);
    zone.append(stage);
    document.body.append(zone);
    zone.getBoundingClientRect = () => new DOMRect(0, 0, 390, 600);
    const send = vi.fn();
    const stop = watchDeadTaps(() => zone, send, () => true);
    return { zone, stage, page, row, send, stop };
  }

  it("logs one line after three taps that nothing answered", () => {
    const { row, send, stop } = chat();
    tap(row, false);
    tap(row, false);
    expect(send).not.toHaveBeenCalled();
    tap(row, false);
    tap(row, false);
    expect(send).toHaveBeenCalledTimes(1);
    const line = send.mock.calls[0]![0];
    expect(line).toMatchObject({ kind: "dead-taps", taps: 3, target: "p", prevented: [] });
    expect(line.targetPath.slice(0, 2).map((node: string) => node.split(" ")[0])).toEqual(["p", "div[phoneChatPage]"]);
    stop();
  });

  it("logs nothing for taps that click", () => {
    const { row, send, stop } = chat();
    for (let i = 0; i < 6; i++) tap(row, true);
    expect(send).not.toHaveBeenCalled();
    stop();
  });

  it("logs taps a layer beside the chat takes, even when the layer clicks", () => {
    const { send, stop } = chat();
    const scrim = document.createElement("div");
    scrim.id = "scrim";
    document.body.append(scrim);
    for (let i = 0; i < 3; i++) tap(scrim, true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ target: "div#scrim" });
    stop();
  });

  it("logs taps on an inert chat page that click the bare column", () => {
    const { zone, stage, send, stop } = chat();
    stage.inert = true;
    for (let i = 0; i < 3; i++) tap(zone, true);
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  it("skips a tap that stops a glide", () => {
    const { page, row, send, stop } = chat();
    for (let i = 0; i < 3; i++) {
      scroll(page);
      tap(row, false);
    }
    expect(send).not.toHaveBeenCalled();
    stop();
  });

  it("does not count a bottom-follow scroll as an answer", () => {
    const { page, row, send, stop } = chat();
    Object.defineProperty(page, "scrollHeight", { value: 1000 });
    for (let i = 0; i < 3; i++) {
      touch("touchstart", row);
      touch("touchend", row);
      page.scrollTop = 0;
      scrollToFollowBottom(page);
      scroll(page);
      vi.advanceTimersByTime(700);
      now += 700;
    }
    expect(page.scrollTop).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores touch events that carry no touch lists", () => {
    const { row, send, stop } = chat();
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    for (const type of ["touchstart", "touchend"]) row.dispatchEvent(new Event(type, { bubbles: true }));
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    stop();
  });

  it("re-arms after a live tap and ignores taps outside the chat", () => {
    const { row, send, stop } = chat();
    const drawer = document.createElement("aside");
    document.body.append(drawer);
    tap(row, false);
    tap(row, false);
    tap(row, true);
    tap(drawer, false, 40, 700);
    tap(row, false);
    tap(row, false);
    expect(send).not.toHaveBeenCalled();
    tap(row, false);
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  function drawerSwitch(menu: Element, drawerRow: Element) {
    tap(menu, true);
    touch("touchstart", drawerRow);
    touch("touchend", drawerRow);
    drawerRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    reportChatSwitch({ type: "select", id: "marketing" }, "wink", "marketing", vi.fn());
    vi.advanceTimersByTime(700);
    now += 700;
  }

  function drawer() {
    const menu = document.createElement("button");
    const drawerRow = document.createElement("button");
    document.body.append(menu, drawerRow);
    return { menu, drawerRow };
  }

  it("re-arms on a chat switch, so menu and drawer taps do not spend the line", () => {
    const { row, send, stop } = chat();
    const { menu, drawerRow } = drawer();
    tap(row, true);
    drawerSwitch(menu, drawerRow);
    drawerSwitch(menu, drawerRow);
    for (let i = 0; i < 3; i++) tap(row, false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ target: "p", taps: 3 });
    stop();
  });

  it("logs nothing for rapid drawer switches alone", () => {
    const { send, stop } = chat();
    const { menu, drawerRow } = drawer();
    for (let i = 0; i < 7; i++) drawerSwitch(menu, drawerRow);
    expect(send).not.toHaveBeenCalled();
    stop();
  });
});
