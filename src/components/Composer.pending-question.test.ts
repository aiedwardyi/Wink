// @vitest-environment happy-dom
// The pinned ask_user question over the composer, against the real store:
// it arrives as the full card and shrinks to one row once the person types,
// attaches or the chat moves on; a tap goes out exactly the way a typed answer
// would, and either x settles the question.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";
import { createBotChatRoutes } from "../../server/bot-chat-routes";
import { Store as ServerStore } from "../../server/store";

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

const screen = (phone: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);

let focused: ReturnType<typeof useStore>["state"]["focusMessage"] = null;
function Probe() {
  focused = useStore().state.focusMessage;
  return null;
}

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
  focused = null;
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
  await act(async () => root!.render(createElement(StoreProvider, null, createElement(Probe), createElement(Composer, props))));
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
const card = () => host!.querySelector<HTMLElement>('[role="region"][data-pending-question]');
const rowButton = (name: string) => {
  const found = [...(row()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === name || button.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no ${name} button on the row`);
  return found;
};
const dot = () => host!.querySelector<HTMLButtonElement>("[data-hidden-question]");
// the row and the card fold past each other; wait out the closing one
const settle = () => act(() => new Promise((done) => setTimeout(done, 200)));
const type = (value: string) => act(async () => {
  const input = textarea()!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
// typing shrinks the card to its row, and clearing the box leaves it there
const shrink = async () => {
  await type("S");
  await type("");
  await settle();
};
const attach = (file: File) => act(async () => {
  const input = host!.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
// the chat view hands the composer its bot again as messages land
const rerender = (props: Parameters<typeof Composer>[0]) => act(async () => root!.render(createElement(StoreProvider, null, createElement(Probe), createElement(Composer, props))));
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
// a finger pulled straight down, lifting where it stopped
const pull = (target: Element, dy: number, ms = 200) => act(async () => {
  for (const [type, y, at] of [["touchstart", 100, 0], ["touchmove", 100 + dy, ms / 2], ["touchend", 100 + dy, ms]] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : [{ clientX: 100, clientY: y }] },
      changedTouches: { value: [{ clientX: 100, clientY: y }] },
      timeStamp: { value: at },
    });
    target.dispatchEvent(event);
  }
});
const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path);

describe("pinned ask_user question", () => {
  it("arrives as the full card with its choices, glowing once", async () => {
    await mount({ bot: bot([question]) });
    expect(row()).toBeNull();
    expect(card()?.getAttribute("aria-label")).toBe("Ada asks");
    expect(card()?.textContent).toContain("Ship to prod or staging?\nStaging has last week's data.");
    expect(pinButton("Prod")).toBeTruthy();
    const glow = card()!.closest(".arrival-glow")!;
    expect(glow).not.toBeNull();
    await act(async () => glow.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName: "arrival-glow-once" })));
    expect(card()!.closest(".arrival-glow")).toBeNull();
    expect(textarea()?.disabled).toBe(false);
  });

  it("caps the card at a third of the chat and scrolls only a long question's text, with the choices under it", async () => {
    await mount({ bot: bot([ask({ subtitle: Array.from({ length: 40 }, (_, line) => `Line ${line}`).join("\n") })]) });
    expect(card()!.className).toContain("max-h-[30dvh]");
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.textContent).toContain("Line 39");
    expect(body.querySelector("[data-term-choices]")).toBeNull();
    expect(body.className).toContain("min-h-[1lh]");
    const choices = body.nextElementSibling!;
    expect(choices.matches("[data-term-choices]")).toBe(true);
    expect(choices.className).toContain("shrink-0");
    expect([...choices.querySelectorAll("button")].map((chip) => chip.textContent)).toEqual(["Prod", "Staging"]);
  });

  it("lets the cap give way for the choices under three lines of the question, or two when it has two", async () => {
    let resized = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    let tall = 262;
    let text = 88;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-term-choices]") ? tall : 0; });
    // a box is never shorter than its own min-height
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-question-body]") ? Math.max(text, parseFloat(this.style.minHeight) || 0) : 0; });
    await mount({ bot: bot([question]) });
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    expect(card()!.style.maxHeight).toBe("max(30dvh, 390px)");
    expect(body.style.minHeight).toBe("66px");
    tall = 54;
    text = 44;
    resized();
    expect(card()!.style.maxHeight).toBe("max(30dvh, 160px)");
    expect(body.style.minHeight).toBe("44px");
  });

  it("stops the card at the composer's room: the question gives lines back first, then the choices scroll", async () => {
    let resized = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
    const computed = globalThis.getComputedStyle;
    const isPane = (el: Element) => el.classList.contains("overflow-y-auto") && !!el.querySelector("[data-pending-question]");
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => (isPane(el) ? { overflowY: "auto" } as CSSStyleDeclaration : computed(el, pseudo)));
    let tall = 252;
    let over = 84;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-term-choices]") ? tall : this.matches("[data-pending-question]") ? tall + 128 : 0; });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-question-body]") ? 88 : isPane(this) ? 304 + over : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return isPane(this) ? 304 : 0; });
    await mount({ bot: bot([question]) });
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    const choices = card()!.querySelector<HTMLElement>("[data-term-choices]")!;
    expect(card()!.style.maxHeight).toBe("296px");
    expect(body.style.minHeight).toBe("66px");
    expect([choices.style.maxHeight, choices.style.overflowY]).toEqual(["168px", "auto"]);
    tall = 200;
    over = 32;
    resized();
    expect(card()!.style.maxHeight).toBe("296px");
    expect(body.style.minHeight).toBe("");
    expect([choices.style.maxHeight, choices.style.overflowY]).toEqual(["", ""]);
    over = 900;
    resized();
    expect(card()!.style.maxHeight).toBe("106px");
    expect([choices.style.maxHeight, choices.style.overflowY]).toEqual(["22px", "auto"]);
  });

  it("lifts the tray's own cap, so a phone keeps three lines of the question with every choice in sight", async () => {
    vi.stubGlobal("ResizeObserver", class { constructor() {} observe() {} disconnect() {} });
    screen(true);
    const sheet = document.head.appendChild(document.createElement("style"));
    sheet.textContent = "[data-composer-tray] { overflow-y: auto; }";
    const isPane = (el: Element) => el.matches("[data-composer-tray]");
    const tall = 170;
    const need = tall + 128;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-term-choices]") ? tall : this.matches("[data-pending-question]") ? need : 0; });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-question-body]") ? 88 : isPane(this) ? need : 0; });
    // a phone's 30dvh tray cap at 844 is 253px, below the card's 298px
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return isPane(this) ? (this.style.maxHeight === "none" ? need : 253) : 0; });
    await mount({ bot: bot([question]) });
    const tray = host!.querySelector<HTMLElement>("[data-composer-tray]")!;
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    const choices = card()!.querySelector<HTMLElement>("[data-term-choices]")!;
    expect(body.style.minHeight).toBe("66px");
    expect([choices.style.maxHeight, choices.style.overflowY]).toEqual(["", ""]);
    expect(tray.style.maxHeight).toBe("none");
    await act(async () => root!.unmount());
    root = null;
    expect(tray.style.maxHeight).toBe("");
    sheet.remove();
  });

  it("ends a cut question on a whole line, never half of one", async () => {
    vi.stubGlobal("ResizeObserver", class { constructor() {} observe() {} disconnect() {} });
    screen(true);
    let shown = 113;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return new DOMRect(0, 0, 0, this.matches("[data-question-body]") ? shown : 0); });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-question-body]") ? 132 : 0; });
    await mount({ bot: bot([question]) });
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    expect(body.style.maxHeight).toBe("110px");
    shown = 110;
    window.dispatchEvent(new Event("resize"));
    expect(body.style.maxHeight).toBe("");
    shown = 120;
    window.dispatchEvent(new Event("resize"));
    expect(body.style.maxHeight).toBe("110px");
    shown = 132;
    window.dispatchEvent(new Event("resize"));
    expect(body.style.maxHeight).toBe("");
  });

  it("keeps a desktop card's window and the tray's cap as they were", async () => {
    vi.stubGlobal("ResizeObserver", class { constructor() {} observe() {} disconnect() {} });
    screen(false);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return new DOMRect(0, 0, 0, this.matches("[data-question-body]") ? 174 : 0); });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-question-body]") ? 1078 : 0; });
    await mount({ bot: bot([ask({ options: ["Prod", "Staging", "Both"] })]) });
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    expect(body.style.maxHeight).toBe("");
    expect(host!.querySelector<HTMLElement>("[data-composer-tray]")!.style.maxHeight).toBe("");
  });

  it("fades a cut question at its foot until it is scrolled to its end", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches("[data-question-body]") ? 88 : 0; });
    await mount({ bot: bot([question]) });
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    expect(body.className).toContain("data-[cut]:[mask-image:linear-gradient(to_bottom,black_60%,transparent)]");
    expect(body.hasAttribute("data-cut")).toBe(true);
    vi.spyOn(body, "scrollTop", "get").mockReturnValue(88);
    await act(async () => body.dispatchEvent(new Event("scroll")));
    expect(body.hasAttribute("data-cut")).toBe(false);
  });

  it("shrinks to its row when the person starts typing, and stays shrunk", async () => {
    // its own thread, so the typed draft stays out of the next test's box
    await mount({ bot: { ...bot([question]), threadId: "typed-thread" } });
    await type("S");
    expect(row()).not.toBeNull();
    await type("");
    await settle();
    expect(row()).not.toBeNull();
    expect(card()).toBeNull();
    await type("St");
    expect(row()).not.toBeNull();
  });

  it("shrinks to its row when a file is attached", async () => {
    // its own thread, so the uploading file stays out of the next test's draft
    await mount({ bot: { ...bot([question]), threadId: "attach-thread" } });
    expect(row()).toBeNull();
    await attach(new File(["x".repeat(16)], "notes.zip", { type: "application/zip" }));
    expect(host!.textContent).toContain("notes.zip");
    expect(row()).not.toBeNull();
  });

  it("shrinks to its row when the asking bot replies after it", async () => {
    await mount({ bot: bot([question]) });
    expect(row()).toBeNull();
    await rerender({ bot: bot([question, { id: "b2", role: "bot", kind: "text", at: 5, text: "Still checking the logs." }]) });
    expect(row()).not.toBeNull();
    expect(row()!.textContent).toContain("Ship to prod or staging?");
  });

  it("shrinks to its row when the person sends a message after it", async () => {
    const open = ask({ staysOpen: true });
    await mount({ bot: bot([open]) });
    await rerender({ bot: bot([open, { id: "u1", role: "user", kind: "text", at: 5, text: "what's for lunch?" }]) });
    expect(row()).not.toBeNull();
  });

  it.each([
    ["a worker's note", { id: "n1", role: "bot", kind: "note", at: 5, text: "[pane 1a2b3c4d] [ALPHA] DONE ALPHA branch=fix/a sha=abc1234 dirty=0" }],
    ["a tool run", { id: "a1", role: "bot", kind: "activity", at: 5, tool: { name: "Read file", ok: true } }],
    ["a peer's line", { id: "p1", role: "user", kind: "text", at: 5, text: "From a peer", from: { botId: "peer", name: "Peer", color: "blue" } }],
    ["a queued line landing by itself", { id: "u1", role: "user", kind: "text", at: 5, text: "also check the logs", queueId: "queue-1" }],
  ] satisfies Array<[string, Message]>)("stays the full card when %s lands after it", async (_name, later) => {
    const open = ask({ staysOpen: true });
    await mount({ bot: bot([open]) });
    await rerender({ bot: bot([open, later]) });
    await settle();
    expect(card()).not.toBeNull();
    expect(row()).toBeNull();
  });

  it("in a room, stays the full card through another member's line and shrinks when its asker replies", async () => {
    const asker = bot([]);
    const other: Bot = { ...bot([]), id: "other", threadId: "other-thread", name: "Bea" };
    const members = [asker, other];
    const open: Message = { ...ask({ staysOpen: true }), from: { botId: asker.id, name: asker.name, color: asker.color } };
    const line = (id: string, by: Bot): Message => ({ id, role: "bot", kind: "text", at: 5, text: "On it.", from: { botId: by.id, name: by.name, color: by.color } });
    const room = (messages: Message[]): Group => ({
      id: "room", threadId: "room-thread", name: "War room", memberIds: [asker.id, other.id], bulletin: "",
      defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1, messages,
    });
    await mount({ group: room([open]), members });
    await rerender({ group: room([open, line("b1", other)]), members });
    await settle();
    expect(card()).not.toBeNull();
    expect(row()).toBeNull();
    await rerender({ group: room([open, line("b1", other), line("b2", asker)]), members });
    expect(row()).not.toBeNull();
  });

  it("shrinks to one row: the count, who asks, the question's first line, its choices and an x", async () => {
    await mount({ bot: bot([question]) });
    await shrink();
    expect(row()).not.toBeNull();
    expect(row()!.textContent).toContain("1");
    expect(row()!.textContent).toContain("Ada asks");
    expect(row()!.textContent).toContain("Ship to prod or staging?");
    expect(row()!.textContent).not.toContain("Staging has last week's data.");
    expect([...row()!.querySelectorAll(".truncate")].at(-1)?.textContent).toBe("Ship to prod or staging?");
    expect(host!.querySelector("[data-term-choices]")).toBeNull();
    expect([...row()!.querySelectorAll("[data-row-choices] button:not([hidden])")].map((chip) => chip.textContent)).toEqual(["Prod", "Staging"]);
    expect(rowButton("Prod").className).toContain("whitespace-nowrap");
    expect(pinButton("Dismiss question")).toBeTruthy();
    expect(row()!.querySelector('[aria-label="Previous question"]')).toBeNull();
  });

  it("answers from a chip on the row exactly as a chip on the card", async () => {
    await mount({ bot: bot([question]) });
    await shrink();
    await act(async () => rowButton("Staging").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ answered: "Staging" }]);
    expect(sent("POST", "/api/bots/asker/messages").map((call) => call.body)).toEqual([{ text: "Staging", threadId: "asker-thread", cardId: question.id, actedAt: expect.any(Number) }]);
  });

  it("glows once when it arrives, then never again", async () => {
    await mount({ bot: bot([question]) });
    const glow = () => card()!.closest(".arrival-glow");
    expect(glow()).not.toBeNull();
    await act(async () => glow()!.dispatchEvent(Object.assign(new Event("animationend", { bubbles: true }), { animationName: "arrival-glow-once" })));
    expect(glow()).toBeNull();
    await act(async () => root!.unmount());
    root = createRoot(host!);
    await act(async () => root!.render(createElement(StoreProvider, null, createElement(Composer, { bot: bot([question]) }))));
    await act(async () => FakeEventSource.current!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
    expect(card()!.closest(".arrival-glow")).toBeNull();
  });

  it("drops a glow cut short, so the question does not pulse again when it comes back", async () => {
    await mount({ bot: bot([question]) });
    expect(card()!.closest(".arrival-glow")).not.toBeNull();
    await act(async () => pinButton("Fold question").click());
    await settle();
    expect(host!.querySelector(".arrival-glow")).toBeNull();
    await swipe(row()!, 200);
    await act(async () => dot()!.click());
    expect(host!.querySelector(".arrival-glow")).toBeNull();
    await expand();
    expect(host!.querySelector(".arrival-glow")).toBeNull();
  });

  it("plays the arrival glow once at about 1.2s, never looping", async () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
    expect(css).toMatch(/\.arrival-glow::before \{[^}]*animation: arrival-glow-once 2s ease-in-out 1;/);
    expect(css).toMatch(/\[data-pending-question\]\.arrival-glow::before \{ animation-duration: 1\.2s; \}/);
  });

  it("opens to the full card on a tap and folds back to the row", async () => {
    await mount({ bot: bot([question]) });
    await shrink();
    await expand();
    expect(row()).toBeNull();
    expect(pin()?.getAttribute("aria-label")).toBe("Ada asks");
    expect(pin()?.textContent).toContain("Ship to prod or staging?\nStaging has last week's data.");
    expect(pinButton("Prod")).toBeTruthy();
    expect(pinButton("Staging")).toBeTruthy();
    expect(document.activeElement).toBe(pinButton("Fold question"));
    await act(async () => pinButton("Fold question").click());
    expect(row()).not.toBeNull();
    await settle();
    expect(document.activeElement).toBe(row()!.querySelector("button[aria-expanded]"));
    expect(host!.querySelector("[data-term-choices]")).toBeNull();
  });

  it("switches between open questions on the row with its arrows, staying a row", async () => {
    const first = ask({ subtitle: "Which region?", options: ["Seoul", "Tokyo"], staysOpen: true });
    const second = ask({ subtitle: "Which plan?", options: ["Pro", "Team"], staysOpen: true });
    await mount({ bot: bot([first, second]) });
    await shrink();
    expect(row()!.textContent).toContain("2/2");
    expect(row()!.textContent).toContain("Which plan?");
    expect(rowButton("Next question").disabled).toBe(true);
    await act(async () => rowButton("Previous question").click());
    expect(row()!.textContent).toContain("1/2");
    expect(row()!.textContent).toContain("Which region?");
    expect(card()).toBeNull();
    expect(rowButton("Previous question").disabled).toBe(true);
    await act(async () => rowButton("Seoul").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${first.id}`).map((call) => call.body)).toEqual([{ answered: "Seoul" }]);
    await rerender({ bot: bot([{ ...first, card: { ...first.card!, answered: "Seoul" } }, second]) });
    expect(row()!.textContent).toContain("Which plan?");
    expect(row()!.querySelector('[aria-label="Previous question"]')).toBeNull();
  });

  it("steps between open questions from the open card, staying open", async () => {
    const first = ask({ subtitle: "Which region?", options: ["Seoul", "Tokyo"], staysOpen: true });
    const second = ask({ subtitle: "Which plan?", options: ["Pro", "Team"], staysOpen: true });
    await mount({ bot: bot([first, second]) });
    expect(card()!.textContent).toContain("2/2");
    await act(async () => pinButton("Previous question").click());
    await settle();
    expect(row()).toBeNull();
    expect(card()!.textContent).toContain("1/2");
    expect(card()!.textContent).toContain("Which region?");
    await act(async () => pinButton("Next question").click());
    await settle();
    expect(row()).toBeNull();
    expect(card()!.textContent).toContain("Which plan?");
  });

  it("steps from a card opened over a draft to the next question open, and from a row to a row", async () => {
    const first = ask({ subtitle: "Which region?", options: ["Seoul", "Tokyo"], staysOpen: true });
    const second = ask({ subtitle: "Which plan?", options: ["Pro", "Team"], staysOpen: true });
    await mount({ bot: bot([first, second]) });
    await type("thinking");
    await settle();
    expect(card()).toBeNull();
    await expand();
    await act(async () => pinButton("Previous question").click());
    await settle();
    expect(row()).toBeNull();
    expect(card()!.textContent).toContain("Which region?");
    await act(async () => pinButton("Fold question").click());
    await settle();
    await act(async () => rowButton("Next question").click());
    await settle();
    expect(card()).toBeNull();
    expect(row()!.textContent).toContain("Which plan?");
    await type("");
  });

  it("keeps the open card being read when a new question arrives, and moves on once it is answered", async () => {
    const first = ask({ subtitle: "Which region?", options: ["Seoul", "Tokyo"], staysOpen: true });
    const second = ask({ subtitle: "Which plan?", options: ["Pro", "Team"], staysOpen: true });
    const third = ask({ subtitle: "Which color?", options: ["Red", "Blue"], staysOpen: true });
    await mount({ bot: bot([first, second]) });
    await act(async () => pinButton("Previous question").click());
    await settle();
    await rerender({ bot: bot([first, second, third]) });
    await settle();
    expect(row()).toBeNull();
    expect(card()!.textContent).toContain("Which region?");
    expect(card()!.textContent).toContain("1/3");
    await rerender({ bot: bot([{ ...first, card: { ...first.card!, answered: "Seoul" } }, second, third]) });
    await settle();
    expect(card()!.textContent).toContain("Which color?");
    expect(card()!.textContent).toContain("2/2");
  });

  it("keeps the card being read over a draft, open or folded, when a new question arrives", async () => {
    const first = ask({ subtitle: "Which region?", options: ["Seoul", "Tokyo"], staysOpen: true });
    const second = ask({ subtitle: "Which plan?", options: ["Pro", "Team"], staysOpen: true });
    const third = ask({ subtitle: "Which color?", options: ["Red", "Blue"], staysOpen: true });
    const fourth = ask({ subtitle: "Which size?", options: ["S", "L"], staysOpen: true });
    await mount({ bot: bot([first, second]) });
    await type("thinking");
    await settle();
    await expand();
    await act(async () => pinButton("Previous question").click());
    await settle();
    await rerender({ bot: bot([first, second, third]) });
    await settle();
    expect(row()).toBeNull();
    expect(card()!.textContent).toContain("Which region?");
    expect(card()!.textContent).toContain("1/3");
    await act(async () => pinButton("Fold question").click());
    await settle();
    await rerender({ bot: bot([first, second, third, fourth]) });
    await settle();
    expect(card()).toBeNull();
    expect(row()!.textContent).toContain("Which region?");
    expect(row()!.textContent).toContain("1/4");
    expect(textarea()!.value).toBe("thinking");
    await type("");
  });

  it("shows a new question after the stepped-to row was swiped away", async () => {
    const first = ask({ subtitle: "Which region?", options: ["Seoul", "Tokyo"], staysOpen: true });
    const second = ask({ subtitle: "Which plan?", options: ["Pro", "Team"], staysOpen: true });
    const third = ask({ subtitle: "Which color?", options: ["Red", "Blue"], staysOpen: true });
    await mount({ bot: bot([first, second]) });
    await shrink();
    await act(async () => rowButton("Previous question").click());
    expect(row()!.textContent).toContain("Which region?");
    await swipe(row()!, 200);
    expect(pin()).toBeNull();
    expect(dot()?.textContent).toBe("2");
    await rerender({ bot: bot([first, second, third]) });
    await settle();
    expect(pin()!.textContent).toContain("Which color?");
    expect(pin()!.textContent).toContain("3/3");
  });

  it("outlines the choices in secondary ink with a 44px touch target", async () => {
    await mount({ bot: bot([question]) });
    const choice = pinButton("Prod").className;
    expect(choice).toContain("rounded-full");
    expect(choice).toContain("bg-control");
    expect(choice).toContain("border-ink-secondary ");
    expect(choice).toContain("pointer-coarse:after:-inset-y-[5px]");
  });

  it("gives the open card's x a 44px touch target without growing the card", async () => {
    await mount({ bot: bot([question]) });
    const dismiss = pinButton("Dismiss question").className;
    expect(dismiss).toContain("p-1 ");
    expect(dismiss).toContain("pointer-coarse:after:-inset-y-[11px]");
    expect(dismiss).not.toMatch(/pointer-coarse:-?(p|m)[xytb]?-/);
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
    await act(async () => pinButton("Prod").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ answered: "Prod" }]);
    expect(sent("POST", "/api/bots/asker/messages").map((call) => call.body)).toEqual([{ text: "Prod", threadId: "asker-thread", cardId: question.id, actedAt: expect.any(Number) }]);
  });

  it("sends a typed answer from the message box while the row shows", async () => {
    // its own thread, so the unsent answer restored to the box stays out of the next test's
    await mount({ bot: { ...bot([ask({ options: [] })]), threadId: "answer-thread" } });
    const input = textarea()!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Staging");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(sent("POST", "/api/bots/asker/messages").map((call) => call.body)).toEqual([expect.objectContaining({ text: "Staging", threadId: "answer-thread" })]);
  });

  it("dismisses with the open card's x", async () => {
    await mount({ bot: bot([question]) });
    await act(async () => pinButton("Dismiss question").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ dismissed: true }]);
    expect(sent("POST", "/api/bots/asker/messages")).toEqual([]);
  });

  it("dismisses with the row's x without leaving a dot", async () => {
    await mount({ bot: bot([question]) });
    await shrink();
    await act(async () => pinButton("Dismiss question").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ dismissed: true }]);
    await rerender({ bot: bot([{ ...question, card: { ...question.card!, dismissed: true } }]) });
    expect(pin()).toBeNull();
    expect(dot()).toBeNull();
    expect(textarea()?.disabled).toBe(false);
  });

  it("saves a row dismissal and sends the same sync row as an answer", async () => {
    const server = new ServerStore(() => ({ instanceId: "claude", model: "opus" }));
    const owner = server.createBot({}, { seedMessages: false });
    const createAsk = () => server.appendMessage(owner.threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: "Which?", options: ["Yes"], askUser: true, staysOpen: true } });
    const dismissed = createAsk();
    const writes: unknown[] = [];
    server.setSyncWriter((threadId, mutations, write) => { writes.push([threadId, mutations]); write(); });
    const routes = createBotChatRoutes({ store: server, clientMessage: (value: unknown) => value } as Parameters<typeof createBotChatRoutes>[0]);
    const patch = async (id: string, body: object) => {
      let status = 0;
      const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: () => {} } as unknown as ServerResponse;
      await routes.patchCard(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", owner.id, id] as RegExpMatchArray);
      expect(status).toBe(200);
    };
    const uiBot = { ...bot([dismissed as Message]), id: owner.id, threadId: owner.threadId };
    await mount({ bot: uiBot });
    const fetch = vi.mocked(globalThis.fetch);
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (init?.method === "PATCH") {
        await patch(dismissed.id, JSON.parse(String(init.body)));
        return Response.json({});
      }
      return original(url, init);
    });
    await shrink();
    await act(async () => row()!.querySelector<HTMLButtonElement>('button:has(svg.lucide-x)')!.click());
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const reloaded = new ServerStore(() => ({ instanceId: "claude", model: "opus" }));
    expect(reloaded.messagesFor(owner.threadId).find((m) => m.id === dismissed.id)?.card?.dismissed).toBe(true);
    expect(writes[0]).toEqual([owner.threadId, [{ kind: "row", value: expect.objectContaining({ id: dismissed.id, card: expect.objectContaining({ dismissed: true }) }) }]]);
    const answered = createAsk();
    writes.length = 0;
    await patch(answered.id, { answered: "Yes" });
    expect(writes[0]).toEqual([owner.threadId, [{ kind: "row", value: expect.objectContaining({ id: answered.id, card: expect.objectContaining({ answered: "Yes" }) }) }]]);
  });

  it("hides on a sideways swipe across the row without dismissing", async () => {
    await mount({ bot: bot([question]) });
    await shrink();
    expect(row()!.className).toContain("touch-pan-y");
    await swipe(row()!, 4, 60);
    expect(row()).not.toBeNull();
    await swipe(row()!, 200);
    expect(row()).toBeNull();
    expect(dot()?.textContent).toBe("1");
    expect(calls).toEqual([]);
  });

  it.each(["card", "row"] as const)("dismisses on a swipe down across the %s on a phone, exactly as its x", async (form) => {
    screen(true);
    await mount({ bot: bot([question]) });
    if (form === "row") await shrink();
    await pull(form === "row" ? row()! : card()!, 200);
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ dismissed: true }]);
    expect(sent("POST", "/api/bots/asker/messages")).toEqual([]);
    await rerender({ bot: bot([{ ...question, card: { ...question.card!, dismissed: true } }]) });
    expect(pin()!.closest("[data-dock-card]")!.hasAttribute("data-closing")).toBe(true);
    expect(pin()!.closest<HTMLElement>("[data-dock-card]")!.style.translate).toBe("0 200px");
    await settle();
    expect(pin()).toBeNull();
    expect(dot()).toBeNull();
  });

  it("springs back from a short slow pull on a phone, still the open card", async () => {
    screen(true);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
    await mount({ bot: bot([question]) });
    await pull(card()!, 60, 600);
    await settle();
    expect(calls).toEqual([]);
    expect(card()).not.toBeNull();
    expect(row()).toBeNull();
  });

  it("leaves a scrolled question's text, a sideways swipe and a tapped choice to do what they did on a phone", async () => {
    screen(true);
    await mount({ bot: bot([question]) });
    const body = card()!.querySelector<HTMLElement>("[data-question-body]")!;
    body.scrollTop = 30;
    await pull(body, 200);
    await swipe(card()!, 200);
    expect(calls).toEqual([]);
    expect(card()).not.toBeNull();
    await act(async () => pinButton("Prod").click());
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ answered: "Prod" }]);
  });

  it("closes at once on a swipe down with reduced motion", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") || query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    await mount({ bot: bot([question]) });
    await pull(card()!, 200);
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`).map((call) => call.body)).toEqual([{ dismissed: true }]);
    await rerender({ bot: bot([{ ...question, card: { ...question.card!, dismissed: true } }]) });
    expect(pin()).toBeNull();
  });

  it("still folds on a swipe down on desktop, and never dismisses there", async () => {
    screen(false);
    await mount({ bot: bot([question]) });
    await pull(card()!, 200);
    expect(row()).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it("counts two open questions as 2 on the row and the dot", async () => {
    const first = ask({ subtitle: "Which region?", staysOpen: true });
    const second = ask({ subtitle: "Which plan?", staysOpen: true });
    await mount({ bot: bot([first, second]) });
    await shrink();
    expect(row()!.textContent).toContain("2/2");
    expect(row()!.textContent).toContain("Which plan?");
    await swipe(row()!, 200);
    expect(dot()?.textContent).toBe("2");
  });

  it("leaves once the person has sent a later message", async () => {
    await mount({ bot: bot([question, { id: "u1", role: "user", kind: "text", at: 4, text: "Staging" }]) });
    expect(pin()).toBeNull();
    expect(dot()).toBeNull();
  });

  it("waits behind a pending approval and leaves the box typeable", async () => {
    await mount({ bot: bot([question, approval]) });
    expect(pin()).toBeNull();
    expect(host!.querySelector('[role="region"][aria-label="Pending approval"]')).not.toBeNull();
    expect(textarea()?.disabled).toBe(false);
  });

  it("names the room member who asked and answers in the room", async () => {
    const member = bot([]);
    const group: Group = {
      id: "room", threadId: "room-thread", name: "War room", memberIds: [member.id], bulletin: "",
      defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1,
      messages: [{ ...question, from: { botId: member.id, name: member.name, color: member.color } }],
    };
    await mount({ group, members: [member] });
    expect(card()?.getAttribute("aria-label")).toBe("Ada asks");
    await shrink();
    expect(row()!.textContent).toContain("Ada asks");
    await expand();
    await act(async () => pinButton("Staging").click());
    expect(sent("PATCH", `/api/groups/room/cards/${question.id}`).map((call) => call.body)).toEqual([{ answered: "Staging" }]);
    expect(sent("POST", "/api/groups/room/messages").map((call) => call.body)).toEqual([
      expect.objectContaining({ text: "Staging", threadId: "room-thread", sendId: expect.any(String) }),
    ]);
  });
});

describe("one tray over the message box", () => {
  const replied: Message = { id: "said-1", role: "bot", kind: "text", text: "Staging is ready", at: 1 };

  it("arrives as the row while the box holds a reply, and a tap still opens it", async () => {
    await mount({ bot: { ...bot([question]), threadId: "reply-thread" }, replyTo: replied });
    expect(card()).toBeNull();
    expect(row()).not.toBeNull();
    await expand();
    expect(card()?.getAttribute("aria-label")).toBe("Ada asks");
  });

  it("puts the reply quote and the pictures on one row inside the capped tray", async () => {
    const shot = { kind: "image", path: "/tmp/shot.png", size: 3, mime: "image/png" };
    localStorage.setItem("omb-draft-attachments", JSON.stringify({
      "bot:asker:tray-thread": [{ ...shot, id: "one", name: "one.png" }, { ...shot, id: "two", name: "two.png" }],
    }));
    await mount({ bot: { ...bot([]), threadId: "tray-thread" }, replyTo: replied });
    const tray = host!.querySelector("[data-composer-tray]");
    expect(tray?.className).toContain("max-h-[35dvh]");
    expect(tray?.className).toContain("overflow-y-auto");
    const together = tray?.querySelector('[data-attachment-tray="row"]');
    expect(together?.textContent).toContain("Replying to Ada");
    expect(together?.querySelectorAll('[aria-label="Remove image"]')).toHaveLength(2);
  });
});

describe("jumping from the question card", () => {
  const reply = (id: string, from?: Message["from"]): Message => ({ id, role: "bot", kind: "text", at: 1, text: "Here is why I am asking.", from });
  const tool = (id: string): Message => ({ id, role: "bot", kind: "activity", at: 1, tool: { name: "Read", ok: true } });
  const tap = () => act(async () => host!.querySelector<HTMLElement>("[data-question-body]")!.click());

  it("lands on the bot's own text from the turn that raised the pinned question", async () => {
    const stamped = ask({ replyId: "reply-1" });
    await mount({ bot: bot([reply("reply-1"), tool("t1"), stamped]) });
    await tap();
    expect(focused).toMatchObject({ threadId: "asker-thread", messageId: "reply-1", consumed: false });
  });

  it("lands on the asking member's text in a room, not another member's", async () => {
    const ada = bot([]);
    const max = { ...bot([]), id: "max", name: "Max" };
    const from = (member: Bot) => ({ botId: member.id, name: member.name, color: member.color });
    const group: Group = {
      id: "room", threadId: "room-thread", name: "War room", memberIds: [ada.id, max.id], bulletin: "",
      defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1,
      messages: [reply("ada-text", from(ada)), reply("max-text", from(max)), { ...ask({ replyId: "ada-text" }), from: from(ada) }],
    };
    await mount({ group, members: [ada, max] });
    await tap();
    expect(focused).toMatchObject({ threadId: "room-thread", messageId: "ada-text" });
  });

  it("does nothing for a question whose turn wrote no text, even with an earlier turn's text above it", async () => {
    await mount({ bot: bot([reply("earlier"), tool("t1"), question]) });
    expect(host!.querySelector("[data-question-body]")!.className).not.toContain("cursor-pointer");
    await tap();
    expect(focused).toBeNull();
  });

  it("jumps to an older open question's own record, reached with the arrows", async () => {
    const older = ask({ staysOpen: true, subtitle: "Older question?" });
    const newest = ask({ staysOpen: true, subtitle: "Newest question?" });
    await mount({ bot: bot([reply("reply-1"), older, newest]) });
    await shrink();
    await act(async () => rowButton("Previous question").click());
    await expand();
    await tap();
    expect(card()?.textContent).toContain("Older question?");
    expect(focused).toMatchObject({ messageId: older.id });
  });

  it("leaves the arrows and the choices to flip and answer, not jump", async () => {
    const older = ask({ staysOpen: true, subtitle: "Older question?" });
    const newest = ask({ staysOpen: true, subtitle: "Newest question?" });
    await mount({ bot: bot([reply("reply-1"), older, newest]) });
    await shrink();
    await act(async () => rowButton("Previous question").click());
    await act(async () => rowButton("Prod").click());
    expect(focused).toBeNull();
    expect(row()!.textContent).toContain("1/2");
  });
});
