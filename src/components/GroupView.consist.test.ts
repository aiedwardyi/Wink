// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, Group, Message } from "@/state/store";
import type { MessageMenuRequest } from "./MessageMenu";

const storeState = vi.hoisted(() => ({ bots: [], instances: [], config: {}, routineRuns: [] }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state: storeState, dispatch: () => undefined }),
    useStoreDispatch: () => () => undefined,
  };
});

import { applyLocale, I18nProvider } from "@/lib/i18n";
import { Transcript } from "./GroupView";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "GroupView.tsx"), "utf8");

const day = Date.UTC(2026, 10, 12, 3);
const mine: Message = { id: "u1", role: "user", kind: "text", at: day, text: "Morning", author: { kind: "host", id: "host", name: "Host" }, roomEntryId: "e1" };
const theirs: Message = { id: "u2", role: "user", kind: "text", at: day + 60_000, text: "Hi all", author: { kind: "person", id: "p1", name: "Seo-yeon Park" }, roomEntryId: "e2" };
const group = { id: "room-1", name: "Room", threadId: "t1", memberIds: [], messages: [], hosted: { roomId: "r1" } } as unknown as Group;

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root?.unmount());
  root = null;
  applyLocale("en");
  localStorage.clear();
  document.body.innerHTML = "";
});

async function show(messages: Message[], onMessageMenu: (menu: MessageMenuRequest) => void = () => undefined, members: Bot[] = []) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(Transcript, {
    group, members, messages, transcript: messages, streamingMessage: null, dock: null, onReply: () => undefined, onMessageMenu, workers: [],
  }))));
  return host;
}

const contextMenu = (el: Element) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));

describe("a host room line reads like a 1:1 line", () => {
  it("folds a long own message behind Show full message", async () => {
    const host = await show([{ ...mine, text: "word ".repeat(200) }]);
    const row = host.querySelector('[data-mid="u1"]')!;
    expect(row.querySelector(".max-h-40")).not.toBeNull();
    const more = [...row.querySelectorAll("button")].find((button) => button.textContent === "Show full message")!;
    await act(async () => more.click());
    expect(row.querySelector(".max-h-40")).toBeNull();
    expect([...row.querySelectorAll("button")].some((button) => button.textContent === "Show less")).toBe(true);
  });

  it("keeps a short own message whole", async () => {
    const host = await show([mine]);
    expect(host.querySelector('[data-mid="u1"] .max-h-40')).toBeNull();
  });

  it("offers reactions in the menu of a teammate's line, not your own", async () => {
    const menu = vi.fn();
    const host = await show([mine, theirs], menu);
    contextMenu(host.querySelector('[data-mid="u2"] [data-orbit-message-content]')!);
    contextMenu(host.querySelector('[data-mid="u1"] [data-orbit-message-content]')!);
    expect(menu.mock.calls.map(([request]) => request.kind === "message" && request.target.user)).toEqual([false, true]);
  });

  it("opens a menu on a file-only line", async () => {
    const menu = vi.fn();
    const files = [{ id: "f2", name: "plan.pdf", type: "application/pdf", bytes: 20 }];
    const host = await show([{ ...theirs, text: "", roomFiles: files }], menu);
    contextMenu(host.querySelector('[data-mid="u2"] [data-orbit-message-content]')!);
    expect(menu).toHaveBeenCalledTimes(1);
  });

  it("shows a plain note the way a 1:1 chat does", async () => {
    const note: Message = { id: "n1", role: "bot", kind: "note", at: day, text: "STATUS: done\nShipped the fix.", from: { botId: "b1", name: "Rando", color: "blue" } };
    const host = await show([note]);
    const button = host.querySelector<HTMLButtonElement>('[data-mid="n1"] button[aria-expanded]');
    expect(button).not.toBeNull();
  });

  it("shows the time as the 1:1 label, with no date tooltip over the bubble", async () => {
    const host = await show([mine]);
    const row = host.querySelector('[data-mid="u1"]')!;
    expect(row.querySelector("[data-orbit-message-content]")!.hasAttribute("title")).toBe(false);
    expect(row.querySelector("button.tabular-nums")).not.toBeNull();
  });

  it("slides your own new line in", async () => {
    const host = await show([mine, theirs]);
    expect(host.querySelector('[data-mid="u1"] [data-orbit-message]')!.className).toContain("animate-msg-in");
    expect(host.querySelector('[data-mid="u2"] [data-orbit-message]')!.className).not.toContain("animate-msg-in");
  });

  it("names an unattributed quoted line after the room's one bot", async () => {
    const bot = { id: "b1", name: "Rando", color: "blue" } as Bot;
    const quoted: Message = { id: "b0", role: "bot", kind: "text", at: day - 1, text: "Earlier" };
    const host = await show([quoted, { ...mine, replyToId: "b0" }], undefined, [bot]);
    expect(host.querySelector('[data-mid="u1"]')!.textContent).toContain("Rando");
  });

  it("renders tool rows, usage limits and errors with the 1:1 components", () => {
    expect(groupView).not.toMatch(/fallbackName="Bot"/);
    expect(groupView).not.toContain("Gauge");
    expect(groupView).toContain("<ActivityChip");
    expect(groupView).toMatch(/<ErrorRow[\s\S]{0,600}usageLimit=\{tool\.usageLimit\}[\s\S]{0,200}identities=/);
  });

  it("fades the menu out and remounts it per spot", () => {
    expect(groupView).toContain("usePresence(menu)");
    expect(groupView).toMatch(/<MessageMenu key=\{`\$\{shownMenu\.x\},\$\{shownMenu\.y\}`\}/);
  });
});
