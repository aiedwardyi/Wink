import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";
import { TeamRoomTranscript } from "./TeamRoomRow";

vi.mock("@/lib/room-translate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/room-translate")>(),
  useTranslationAvailable: () => false,
}));

let root: Root | null = null;
let resize: () => void;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(TeamRoomTranscript, { onReply: () => {},
    lines: [{ id: "picture", at: Date.now(), author: { kind: "host", id: "host", name: "Mina" }, text: "", files: [{ id: "file", name: "design.png", bytes: 100, type: "image/png" }] }],
    mine: () => false, base: "/api/rooms/r1", label: "Design team",
  }))));
  const pane = host.querySelector<HTMLElement>("[data-team-room-transcript]")!;
  let height = 1000;
  let viewport = 500;
  let top = 500;
  Object.defineProperties(pane, {
    clientHeight: { get: () => viewport }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.min(height - viewport, value); } },
  });
  return { pane, grow: () => { height += 220; }, expand: () => { viewport += 100; top = Math.min(height - viewport, top); } };
}

it("stays at the exact bottom when picture growth sends a scroll before the resize callback", async () => {
  const { pane, grow } = await mount();
  grow();
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  await act(async () => resize());
  expect(pane.scrollHeight - pane.scrollTop - pane.clientHeight).toBe(0);
});

it("does not pull a reader back down after an upward wheel gesture", async () => {
  const { pane, grow } = await mount();
  const wheel = new Event("wheel", { bubbles: true });
  Object.defineProperty(wheel, "deltaY", { value: -100 });
  await act(async () => pane.dispatchEvent(wheel));
  pane.scrollTop = 300;
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  grow();
  await act(async () => resize());
  expect(pane.scrollTop).toBe(300);
});

it("keeps the scrollbar's upward position when a picture grows", async () => {
  const { pane, grow } = await mount();
  await act(async () => resize());
  pane.scrollTop = 300;
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  grow();
  await act(async () => resize());
  expect(pane.scrollTop).toBe(300);
});

it("keeps following when a taller viewport moves the scroll position upward", async () => {
  const { pane, grow, expand } = await mount();
  await act(async () => resize());
  expand();
  await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
  grow();
  await act(async () => resize());
  expect(pane.scrollHeight - pane.scrollTop - pane.clientHeight).toBe(0);
});

it("labels old lines by current author id and keeps departed names", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const lines: RoomLine[] = [
    { id: "a", at: 1, author: { kind: "person", id: "p1", name: "Mina" }, text: "old line", files: [] },
    { id: "b", at: 2, author: { kind: "host", id: "host", name: "Edward" }, text: "host line", files: [] },
    { id: "c", at: 3, author: { kind: "person", id: "gone", name: "Daniel Cho" }, text: "left", files: [] },
  ];
  try {
    await act(async () => root.render(createElement(TeamRoomTranscript, { onReply: () => {},
      lines, mine: () => false, base: "", label: "Room", hostName: "에드워드", people: [{ id: "p1", name: "민아" }],
    })));
    expect(host.textContent).toContain("민아");
    expect(host.textContent).toContain("에드워드");
    expect(host.textContent).toContain("Daniel Cho");
    expect(host.textContent).not.toContain("Mina");
  } finally {
    await act(async () => root.unmount());
  }
});

it("opens the message menu from the keyboard", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const lines: RoomLine[] = [{ id: "m1", at: 1, author: { kind: "person", id: "p1", name: "Mina" }, text: "hello", files: [] }];
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(TeamRoomTranscript, { onReply: () => {}, lines, mine: () => false, base: "", label: "Room" }))));
  const row = host.querySelector<HTMLElement>('[data-mid="m1"]')!;
  await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true })));
  expect(document.querySelector("[data-message-menu]")).not.toBeNull();
});

it("names a bot line with the bot's face, on the left", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(TeamRoomTranscript, { onReply: () => {},
    lines: [{ id: "answer", at: Date.now(), author: { kind: "bot", id: "b1", name: "Wink" }, color: "blue", text: "on it", files: [] }],
    mine: () => false, base: "/api/joined/rooms/r1", label: "Crew",
  }))));
  const row = host.querySelector<HTMLElement>('[data-mid="answer"]')!;
  expect(row.dataset.teamRoomLine).toBe("theirs");
  const label = host.querySelector<HTMLElement>("[data-team-room-bot]")!;
  expect(label.textContent).toBe("Wink");
  expect(label.querySelector("svg, img")).not.toBeNull();
});

it("renders a bot line's markdown and makes web links clickable on every line", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(TeamRoomTranscript, { onReply: () => {},
    lines: [
      { id: "bot", at: 1, author: { kind: "bot", id: "b1", name: "Wink" }, color: "blue", text: "**Done** - see [notes](C:/work/notes.md) and https://example.com/a.", files: [] },
      { id: "person", at: 2, author: { kind: "person", id: "p1", name: "Mina" }, text: "**not bold** see https://example.com/b, ok", files: [] },
    ],
    mine: () => false, base: "/api/joined/rooms/r1", label: "Crew",
  }))));
  const bot = host.querySelector<HTMLElement>('[data-mid="bot"]')!;
  expect(bot.querySelector("strong")?.textContent).toBe("Done");
  expect(bot.textContent).not.toContain("**");
  expect([...bot.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a"]);
  expect(bot.textContent).toContain("notes");
  const person = host.querySelector<HTMLElement>('[data-mid="person"]')!;
  expect(person.textContent).toContain("**not bold**");
  expect([...person.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/b"]);
});

it("links bare domains in own, teammate and bot room bubbles", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const text = "starzum.com www.x.io x.co.kr https://example.com file.ts v1.0.259 e.g. person@example.com";
  await act(async () => root!.render(createElement(I18nProvider, null, createElement(TeamRoomTranscript, {
    onReply: () => {}, base: "/api/rooms/r1", label: "Crew", mine: (line) => line.author.kind === "host",
    lines: ["host", "person", "bot"].map((kind) => ({ id: kind, at: Date.now(), author: { kind, id: kind, name: kind }, text, files: [] })) as RoomLine[],
  }))));
  for (const kind of ["host", "person", "bot"]) {
    const links = [...host.querySelectorAll<HTMLAnchorElement>(`[data-mid="${kind}"] a`)];
    expect(links.filter((link) => !link.href.startsWith("mailto:")).map((link) => link.getAttribute("href"))).toEqual([
      "https://starzum.com", kind === "bot" ? "http://www.x.io" : "https://www.x.io", "https://x.co.kr", "https://example.com",
    ]);
  }
});

describe("room transcript reads like a 1:1 chat", () => {
  const day = 86_400_000;
  const line = (id: string, at: number, extra: Partial<RoomLine> = {}): RoomLine => ({ id, at, author: { kind: "person", id: "p1", name: "Mina" }, text: `text ${id}`, files: [], ...extra });
  async function show(lines: RoomLine[], onReply = vi.fn()) {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement(I18nProvider, null, createElement(TeamRoomTranscript, { onReply, lines, mine: () => false, base: "/api/rooms/r1", label: "Room" }))));
    return host;
  }

  it("copies and replies from the hover row", async () => {
    const onReply = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const host = await show([line("m1", Date.now())], onReply);
    await act(async () => host.querySelector<HTMLElement>('[data-mid="m1"] button[aria-label="Copy message"]')!.click());
    expect(writeText).toHaveBeenCalledWith("text m1");
    await act(async () => host.querySelector<HTMLElement>('[data-mid="m1"] button[aria-label="Reply to message"]')!.click());
    expect(onReply.mock.calls[0][0].id).toBe("m1");
  });

  it("shows the 1:1 timestamp with its full date tip", async () => {
    const host = await show([line("m1", Date.now())]);
    const stamp = host.querySelector<HTMLButtonElement>('[data-mid="m1"] button.tabular-nums')!;
    await act(async () => stamp.focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("separates days like a 1:1 chat", async () => {
    const now = Date.now();
    const host = await show([line("a", now - 3 * day), line("b", now - 3 * day + 1000), line("c", now)]);
    expect(host.querySelectorAll("[data-day-separator]")).toHaveLength(2);
    expect(host.textContent).toContain("Today");
  });

  it("opens room pictures in the shared viewer with next", async () => {
    vi.stubGlobal("Image", class { src = ""; });
    const picture = (id: string) => ({ id, name: `${id}.png`, bytes: 10, type: "image/png" });
    const host = await show([line("a", Date.now(), { text: "", files: [picture("one")] }), line("b", Date.now(), { text: "", files: [picture("two")] })]);
    await act(async () => host.querySelector<HTMLElement>('[data-mid="a"] [aria-label="Preview attached image one.png"]')!.click());
    expect(document.querySelector("[data-viewer-next]")).not.toBeNull();
  });

  it("jumps back to the latest line after scrolling up", async () => {
    const host = await show([line("a", Date.now()), line("b", Date.now())]);
    const pane = host.querySelector<HTMLElement>("[data-team-room-transcript]")!;
    let top = 500;
    Object.defineProperties(pane, {
      clientHeight: { get: () => 500 }, scrollHeight: { get: () => 1000 },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.min(500, value); } },
    });
    expect(host.querySelector("[data-jump-latest]")).toBeNull();
    const wheel = new Event("wheel", { bubbles: true });
    Object.defineProperty(wheel, "deltaY", { value: -100 });
    await act(async () => pane.dispatchEvent(wheel));
    top = 100;
    await act(async () => pane.dispatchEvent(new Event("scroll", { bubbles: true })));
    await act(async () => host.querySelector<HTMLElement>("[data-jump-latest]")!.click());
    expect(top).toBe(500);
    expect(host.querySelector("[data-jump-latest]")).toBeNull();
  });
});
