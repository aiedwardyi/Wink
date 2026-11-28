// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Action } from "@/state/store-types";
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

function touch(type: string, target: Element, x = 40, y = 40) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
  Object.defineProperty(event, "changedTouches", { value: [point] });
  target.dispatchEvent(event);
}

function tap(target: Element, live: boolean) {
  touch("touchstart", target);
  touch("touchend", target);
  if (live) target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  vi.advanceTimersByTime(700);
}

describe("dead tap catcher", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function chat() {
    vi.useFakeTimers();
    const zone = document.createElement("div");
    const row = document.createElement("p");
    zone.append(row);
    document.body.append(zone);
    const send = vi.fn();
    const stop = watchDeadTaps(() => zone, send, () => true);
    return { zone, row, send, stop };
  }

  it("logs one line after three taps that nothing answered", () => {
    const { row, send, stop } = chat();
    tap(row, false);
    tap(row, false);
    expect(send).not.toHaveBeenCalled();
    tap(row, false);
    tap(row, false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ kind: "dead-taps", taps: 3, target: "p", prevented: [] });
    stop();
  });

  it("logs nothing for taps that click", () => {
    const { row, send, stop } = chat();
    for (let i = 0; i < 6; i++) tap(row, true);
    expect(send).not.toHaveBeenCalled();
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
    tap(drawer, false);
    tap(row, false);
    tap(row, false);
    expect(send).not.toHaveBeenCalled();
    tap(row, false);
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });
});
