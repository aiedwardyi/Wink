import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ bots: new Array<Bot>(), dispatch: vi.fn() }));

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: { bots: h.bots, acceptedSends: {}, instances: [], pendingQueued: {} },
    dispatch: h.dispatch,
  }),
}));

import { type Bot, type Group } from "@/state/store";
import { Composer } from "./Composer";

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

const bot = (id: string): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [],
  modelSelection: { instanceId: "grok", model: "grok" },
});

const active = bot("Active");
const scout = bot("Scout");
const group: Group = {
  id: "room", threadId: "room-thread", name: "Room", memberIds: [scout.id], messages: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0,
};

const mount = async (props: Parameters<typeof Composer>[0]) => {
  h.bots = [active, scout, bot("Sage")];
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement("div", null,
    createElement("p", { "data-chat": "" }, "transcript"),
    createElement(Composer, props),
  )));
};

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  window.localStorage.clear();
  vi.clearAllMocks();
});

const box = () => host!.querySelector("textarea")!;
const picker = () => host!.querySelector('[role="listbox"]');
const type = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
  box().setSelectionRange(value.length, value.length);
  box().dispatchEvent(new Event("input", { bubbles: true }));
});
const press = (target: Element) => act(async () => {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
});

describe("mention picker dismiss", () => {
  beforeEach(() => mount({ bot: active }));

  it.each(["chat", "composer"])("closes on a press on the %s", async (where) => {
    await type("hi @S");
    expect(picker()).not.toBeNull();
    await press(where === "chat" ? host!.querySelector("[data-chat]")! : box());
    expect(picker()).toBeNull();
  });

  it("still picks a row", async () => {
    await type("@Sc");
    const row = host!.querySelector<HTMLElement>('[role="option"]')!;
    await press(row);
    expect(picker()).not.toBeNull();
    await act(async () => row.click());
    expect(box().value).toBe("@Scout ");
    expect(picker()).toBeNull();
  });

  it.each(["press", "Escape"])("reopens after %s once the @ word changes", async (how) => {
    await type("hi @S");
    if (how === "press") await press(host!.querySelector("[data-chat]")!);
    else await act(async () => box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(picker()).toBeNull();
    await type("hi @S");
    expect(picker()).toBeNull();
    await type("hi @Sa");
    expect([...host!.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["SageAgent"]);
    await type("hi @Sa @");
    expect(picker()).not.toBeNull();
  });
});

describe("@ then a space", () => {
  it("is not a tag, so Enter does not pick everyone", async () => {
    await mount({ group, members: [scout] });
    await type("@ ");
    expect(picker()).toBeNull();
    await act(async () => box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(box().value).not.toBe("@everyone ");
    await type("@ev");
    expect([...host!.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["everyoneGroup"]);
  });
});
