// @vitest-environment happy-dom
// The pinned ask_user question over the composer, against the real store:
// it arrives as one row, a tap goes out exactly the way a typed answer would,
// the row's x only hides it, and the open card's x settles it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Group, type Message } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

// Fold and hide state lives per question id, so every test asks a fresh one.
let asked = 0;
let question: Message;
const ask = (card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: `ask-${++asked}`,
  role: "bot",
  kind: "options",
  at: 2,
  card: {
    title: "Your bot has a question",
    subtitle: "Ship to prod or staging?\nStaging has last week's data.",
    options: ["Prod", "Staging"],
    askUser: true,
    ...card,
  },
});
const approval: Message = {
  id: "approval-1",
  role: "bot",
  kind: "options",
  at: 3,
  card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" },
};

const bot = (messages: Message[]): Bot => ({
  id: "asker", threadId: "asker-thread", name: "Ada", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages, busy: true, activity: "working",
  modelSelection: { instanceId: "claude", model: "claude" },
});

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
const calls: Array<{ method: string; path: string; body: unknown }> = [];

beforeEach(() => {
  question = ask();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  calls.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Loads the chat into the store the way the app does, then mounts its composer. */
async function mount(props: Parameters<typeof Composer>[0]) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/bots?messages=200") {
      return new Response(JSON.stringify({ bots: [props.bot, ...(props.members ?? [])].filter(Boolean), groups: [props.group].filter(Boolean) }));
    }
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(StoreProvider, null, createElement(Composer, props))));
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
}

const pin = () => host!.querySelector("[data-pending-question]");
const textarea = () => host!.querySelector("textarea");
const pinButton = (name: string) => {
  const found = [...(pin()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === name || button.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no ${name} button in the pin`);
  return found;
};
const row = () => host!.querySelector<HTMLElement>("[data-question-row]");
const dot = () => host!.querySelector<HTMLButtonElement>("[data-hidden-question]");
// the row and the card fold past each other; wait out the closing one
const settle = () => act(() => new Promise((done) => setTimeout(done, 200)));
const expand = async () => {
  await act(async () => row()!.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  await settle();
};
const swipe = (target: Element, dx: number, dy = 0) => act(async () => {
  const touch = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] },
      changedTouches: { value: [{ clientX: x, clientY: y }] } });
    target.dispatchEvent(event);
  };
  touch("touchstart", 100, 100);
  touch("touchmove", 100 + dx / 2, 100 + dy / 2);
  touch("touchend", 100 + dx, 100 + dy);
});
const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);

describe("pinned ask_user question", () => {
  it("arrives as one row: the count, who asks, the question's first line and an x", async () => {
    await mount({ bot: bot([question]) });
    expect(row()).not.toBeNull();
    expect(row()!.textContent).toContain("1");
    expect(row()!.textContent).toContain("Ada asks");
    expect(row()!.textContent).toContain("Ship to prod or staging?");
    expect(row()!.textContent).not.toContain("Staging has last week's data.");
    expect([...row()!.querySelectorAll(".truncate")].at(-1)?.textContent).toBe("Ship to prod or staging?");
    expect(host!.querySelector("[data-term-choices]")).toBeNull();
    expect(pinButton("Hide question")).toBeTruthy();
    expect(textarea()?.disabled).toBe(false);
  });

  it("glows once when it arrives, then never again", async () => {
    await mount({ bot: bot([question]) });
    expect(row()!.classList.contains("arrival-glow")).toBe(true);
    await act(async () => row()!.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName: "arrival-glow-once" })));
    expect(row()!.classList.contains("arrival-glow")).toBe(false);
    await act(async () => root!.unmount());
    root = createRoot(host!);
    await act(async () => root!.render(createElement(StoreProvider, null, createElement(Composer, { bot: bot([question]) }))));
    await act(async () => FakeEventSource.current!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
    expect(row()!.classList.contains("arrival-glow")).toBe(false);
  });

  it("plays the arrival glow once at about 1.2s, never looping", async () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    expect(css).toMatch(/\.arrival-glow::before \{[^}]*animation: arrival-glow-once 2s ease-in-out 1;/);
    expect(css).toMatch(/\[data-question-row\]\.arrival-glow::before \{ animation-duration: 1\.2s; \}/);
  });

  it("opens to the full card on a tap and folds back to the row", async () => {
    await mount({ bot: bot([question]) });
    await expand();
    expect(row()).toBeNull();
    expect(pin()?.getAttribute("aria-label")).toBe("Ada asks");
    expect(pin()?.textContent).toContain("Ship to prod or staging?\nStaging has last week's data.");
    expect(pinButton("Prod")).toBeTruthy();
    expect(pinButton("Staging")).toBeTruthy();
    await act(async () => pinButton("Fold question").click());
    expect(row()).not.toBeNull();
    await settle();
    expect(host!.querySelector("[data-term-choices]")).toBeNull();
  });

  it("outlines the choices in secondary ink with a 44px touch height", async () => {
    await mount({ bot: bot([question]) });
    await expand();
    const choice = pinButton("Prod").className;
    expect(choice).toContain("rounded-full");
    expect(choice).toContain("bg-control");
    expect(choice).toContain("border-ink-secondary ");
    expect(choice).toContain("pointer-coarse:min-h-11");
  });

  it("gives the open card's x a 44px touch target without growing the card", async () => {
    await mount({ bot: bot([question]) });
    await expand();
    const dismiss = pinButton("Dismiss question").className;
    expect(dismiss).toContain("p-1 ");
    expect(dismiss).toContain("pointer-coarse:-my-3");
    expect(dismiss).toContain("pointer-coarse:px-[15px] pointer-coarse:pt-[14px] pointer-coarse:pb-4");
  });

  it("asks to type the answer while an open question is pinned", async () => {
    await mount({ bot: bot([ask({ options: [] })]) });
    expect(textarea()?.placeholder).toBe("Type your answer");
  });

  it("keeps the usual placeholder for a question with choices", async () => {
    await mount({ bot: bot([question]) });
    expect(textarea()?.placeholder).toBe("Message Ada");
  });

  it("sends a tapped choice as the answer and persists answered, not dismissed", async () => {
    await mount({ bot: bot([question]) });
    await expand();
    await act(async () => pinButton("Prod").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ answered: "Prod" }]);
    expect(sent("POST", "/api/bots/asker/messages").map((call) => call.body)).toEqual([{ text: "Prod", threadId: "asker-thread" }]);
  });

  it("sends a typed answer from the message box while the row shows", async () => {
    await mount({ bot: bot([ask({ options: [] })]) });
    const input = textarea()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Staging");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(sent("POST", "/api/bots/asker/messages").map((call) => call.body)).toEqual([expect.objectContaining({ text: "Staging", threadId: "asker-thread" })]);
  });

  it("dismisses with the open card's x", async () => {
    await mount({ bot: bot([question]) });
    await expand();
    await act(async () => pinButton("Dismiss question").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ dismissed: true }]);
    expect(sent("POST", "/api/bots/asker/messages")).toEqual([]);
  });

  it("hides with the row's x without dismissing, and the composer's dot brings it back", async () => {
    await mount({ bot: bot([question]) });
    await act(async () => pinButton("Hide question").click());
    expect(pin()).toBeNull();
    expect(calls).toEqual([]);
    expect(dot()?.textContent).toBe("1");
    expect(dot()?.getAttribute("aria-label")).toBe("Show question");
    expect(dot()!.closest("[data-orbit-composer-frame]")).not.toBeNull();
    await act(async () => dot()!.click());
    expect(row()).not.toBeNull();
    expect(dot()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("hides on a sideways swipe across the row without dismissing", async () => {
    await mount({ bot: bot([question]) });
    expect(row()!.className).toContain("touch-pan-y");
    await swipe(row()!, 4, 60);
    expect(row()).not.toBeNull();
    await swipe(row()!, 200);
    expect(row()).toBeNull();
    expect(dot()?.textContent).toBe("1");
    expect(calls).toEqual([]);
  });

  it("counts two open questions as 2 on the row and the dot", async () => {
    const first = ask({ subtitle: "Which region?", staysOpen: true });
    const second = ask({ subtitle: "Which plan?", staysOpen: true });
    await mount({ bot: bot([first, second]) });
    expect(row()!.textContent).toContain("2");
    expect(row()!.textContent).toContain("Which plan?");
    await act(async () => pinButton("Hide question").click());
    expect(dot()?.textContent).toBe("2");
  });

  it("leaves once the person has sent a later message", async () => {
    await mount({ bot: bot([question, { id: "u1", role: "user", kind: "text", at: 4, text: "Staging" }]) });
    expect(pin()).toBeNull();
    expect(dot()).toBeNull();
  });

  it("waits behind a pending approval, which keeps its composer takeover", async () => {
    await mount({ bot: bot([question, approval]) });
    expect(pin()).toBeNull();
    expect(host!.querySelector('[role="region"][aria-label="Pending approval"]')).not.toBeNull();
    expect(textarea()?.disabled).toBe(true);
  });

  it("names the room member who asked and answers in the room", async () => {
    const member = bot([]);
    const group: Group = {
      id: "room", threadId: "room-thread", name: "War room", memberIds: [member.id], bulletin: "",
      defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1,
      messages: [{ ...question, from: { botId: member.id, name: member.name, color: member.color } }],
    };
    await mount({ group, members: [member] });
    expect(row()!.textContent).toContain("Ada asks");
    await expand();
    expect(pin()?.getAttribute("aria-label")).toBe("Ada asks");
    await act(async () => pinButton("Staging").click());
    expect(sent("PATCH", `/api/groups/room/cards/${question.id}`).map((call) => call.body)).toEqual([{ answered: "Staging" }]);
    expect(sent("POST", "/api/groups/room/messages").map((call) => call.body)).toEqual([
      expect.objectContaining({ text: "Staging", threadId: "room-thread", sendId: expect.any(String) }),
    ]);
  });
});
