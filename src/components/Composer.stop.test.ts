import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: vi.fn(async () => ({})),
    useStore: () => ({
      state: {
        acceptedSends: {},
        bots: [],
        composerFocusBotId: null,
        instances: [],
        pendingQueued: {},
      },
      dispatch,
    }),
  };
});

import { Composer } from "./Composer";
import type { Bot, Group } from "@/state/store";
import { applyLocale } from "@/lib/i18n";

const bot: Bot = {
  id: "stopper", threadId: "stopper-thread", name: "Stopper", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy: true, activity: "working",
  modelSelection: { instanceId: "claude", model: "claude" },
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function mount(subject: Bot, extra?: { onCall?: () => void }) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Composer, { bot: subject, ...extra })));
}

const stopButton = () => {
  const button = host!.querySelector('button[aria-label="Stop this turn"]');
  if (!(button instanceof HTMLElement)) throw new Error("stop button did not render");
  return button;
};

const interrupts = () => dispatch.mock.calls.filter(([action]) => action.type === "interrupt");

describe("composer stop", () => {
  it("looks like a filled stop button", async () => {
    await mount(bot);
    expect(stopButton().className).toEqual(expect.stringContaining("bg-ink text-app"));
  });

  it("keeps Call after Stop in the empty corner while busy", async () => {
    const onCall = vi.fn();
    await mount(bot, { onCall });
    const call = host!.querySelector('button[aria-label="Call Stopper"]');
    if (!(call instanceof HTMLElement)) throw new Error("call button did not render");
    expect(stopButton().compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => call.click());
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(interrupts()).toHaveLength(0);
  });

  it("hides Call once there is text while busy", async () => {
    await mount(bot, { onCall: vi.fn() });
    const input = host!.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "hi");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(stopButton()).not.toBeNull();
    expect(host!.querySelector('button[aria-label="Call Stopper"]')).toBeNull();
  });

  it("marks Stop for skin styling without changing its size or labels", async () => {
    await mount(bot);
    expect(stopButton().getAttribute("data-orbit-composer-stop")).toBe("");
    expect(stopButton().className).toContain("size-8");
    expect(stopButton().getAttribute("title")).toBe("Stop");
    expect(stopButton().querySelector("svg")?.classList.contains("fill-current")).toBe(true);
  });

  it("shows stopping at once and sends one interrupt for repeat clicks", async () => {
    await mount(bot);
    for (let i = 0; i < 5; i++) await act(async () => stopButton().click());
    expect(interrupts()).toHaveLength(1);
    expect(stopButton().getAttribute("aria-busy")).toBe("true");
  });

  it("keeps Stop live when the turn is still running after the interrupt settles", async () => {
    await mount(bot);
    await act(async () => stopButton().click());
    await act(async () => interrupts()[0]![0].onSettled());
    expect(stopButton().getAttribute("aria-busy")).toBe("false");
    await act(async () => stopButton().click());
    expect(interrupts()).toHaveLength(2);
  });
});

describe("composer stop on a call", () => {
  it("leaves End as the only stop-shaped control while a call is on", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(Composer, { bot, call: () => createElement("button", { "aria-label": "End call" }) })));
    expect(host.querySelector('button[aria-label="End call"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Stop this turn"]')).toBeNull();
  });
});

describe("composer stop on a bot handoff", () => {
  const room = { id: "g1", threadId: "g1-thread", name: "Team", memberIds: [], messages: [], hosted: { roomId: "r1" }, working: false } as unknown as Group;

  async function mountRoom(group: Group) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(Composer, { group, members: [] })));
  }

  afterEach(() => applyLocale("en"));

  it.each([
    ["en", "Bots are working it out · turn 3"],
    ["ko", "봇끼리 맞추는 중 · 3턴"],
  ] as const)("shows the %s strip with a room Stop while no host bot works", async (locale, text) => {
    applyLocale(locale);
    await mountRoom({ ...room, botChain: 3 });
    const strip = host!.querySelector<HTMLElement>("[data-bot-chain]")!;
    expect(strip.textContent).toBe(text);
    expect(strip.className).toContain("text-[12px]");
    await act(async () => host!.querySelector<HTMLElement>("[data-orbit-composer-stop]")!.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toContainEqual({ type: "interruptGroup", groupId: "g1" });
  });

  it("shows no strip or Stop once the handoff ends", async () => {
    await mountRoom(room);
    expect(host!.querySelector("[data-bot-chain]")).toBeNull();
    expect(host!.querySelector("[data-orbit-composer-stop]")).toBeNull();
  });
});
