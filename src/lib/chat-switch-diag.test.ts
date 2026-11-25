// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import type { Action } from "@/state/store-types";
import { noteDispatch, reportChatSwitch } from "./chat-switch-diag";

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
