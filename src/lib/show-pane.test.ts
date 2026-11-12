// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { autoShowStep, closeShow, showableLinks, showItem, showKind, showMedia, togglePane, useAutoShow, useMediaThread, useShowItem, type AutoShow, type ShowItem } from "./show-pane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = (id: string): Message => ({ id, role: "user", kind: "text", text: "make it", at: 1 });
const bot = (id: string, text: string): Message => ({ id, role: "bot", kind: "text", text, at: 2 });
const deck = bot("b1", "Done: [launch-deck.pdf](C:\\work\\launch-deck.pdf)");
const page = bot("b2", "Live: [sync-flow.html](C:\\work\\sync-flow.html)");

function walk(steps: Array<{ thread?: string; messages: Message[]; closed?: boolean }>) {
  let state: AutoShow = { seen: null };
  return steps.map(({ thread = "t1", messages, closed = false }) => {
    const step = autoShowStep(state, thread, messages, closed);
    state = step.state;
    return step.item?.path ?? null;
  });
}

it("reads the kinds the pane shows and nothing else", () => {
  expect(["a.PNG", "b.jpeg", "c.pdf", "d.html", "e.htm", "f.pptx", "g", ".pdf"].map(showKind)).toEqual(["image", "image", "pdf", "page", "page", null, null, null]);
});

it("finds absolute file links, angle-bracketed and file:// ones too", () => {
  const text = "See [a](C:\\w\\a.png), [b](</Users/me/My Deck.pdf>), [c](file:///C:/w/c.html), [d](https://x.dev/d.html), [e](notes.pdf) and [f](C:\\w\\f.zip)";
  expect(showableLinks(text)).toEqual(["C:\\w\\a.png", "/Users/me/My Deck.pdf", "C:/w/c.html"]);
});

it("reads link paths the way the chat renders them", () => {
  const text = "[a](C:/My%20Drive/a.pdf) [b](C:/My Drive/b.pdf) [c](C:/w/c.png#top) `[d](C:/w/d.png)`\n```\n[e](C:/w/e.png)\n```";
  expect(showableLinks(text)).toEqual(["C:/My Drive/a.pdf", "C:/w/c.png"]);
});

it("opens on its own only for a file handed over while the chat is open", () => {
  const before = [user("u1"), deck];
  expect(walk([{ messages: before }, { messages: [...before, page] }])).toEqual([null, "C:\\work\\sync-flow.html"]);
});

it("never opens for files that were there when the chat was opened", () => {
  expect(walk([{ messages: [] }, { messages: [user("u1"), deck] }, { thread: "t2", messages: [user("u9"), page] }])).toEqual([null, null, null]);
});

it("skips older pages that load above the seen messages", () => {
  const latest = [user("u2"), bot("b3", "ok")];
  expect(walk([{ messages: latest }, { messages: [user("u1"), deck, ...latest] }])).toEqual([null, null]);
});

it("does not open again after a close in the same turn, and does on the next turn", () => {
  const turn = [user("u1"), bot("b0", "on it")];
  expect(walk([
    { messages: turn },
    { messages: [...turn, deck] },
    { messages: [...turn, deck], closed: true },
    { messages: [...turn, deck, page] },
    { messages: [...turn, deck, page, user("u2"), bot("b4", "[again.png](C:\\work\\again.png)")] },
  ])).toEqual([null, "C:\\work\\launch-deck.pdf", null, null, "C:\\work\\again.png"]);
});

let host: HTMLElement;
let root: Root;
let shown: ShowItem | null = null;
let media: string | null = null;

function Probe({ thread, messages, free }: { thread: string; messages: Message[]; free: boolean }) {
  useAutoShow(thread, messages, free);
  shown = useShowItem();
  media = useMediaThread();
  return null;
}

const render = (thread: string, messages: Message[], free = true) => act(async () => root.render(createElement(Probe, { thread, messages, free })));

beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
  shown = null;
  media = null;
});
afterEach(() => { act(() => root.unmount()); act(() => closeShow()); });

it("opens a new file in the open chat, and stays shut after the user closes it this turn", async () => {
  const turn = [user("u1")];
  await render("t1", turn);
  await render("t1", [...turn, deck]);
  expect(shown).toEqual({ threadId: "t1", path: "C:\\work\\launch-deck.pdf", kind: "pdf" });
  await act(async () => closeShow());
  await render("t1", [...turn, deck, page]);
  expect(shown).toBeNull();
});

it("leaves the slot alone while something else holds it", async () => {
  await render("t1", [user("u1")], false);
  await render("t1", [user("u1"), deck], false);
  expect(shown).toBeNull();
});

it("a card tap shows a file again after a close", async () => {
  await render("t1", [user("u1"), deck]);
  await act(async () => showItem({ threadId: "t1", path: "C:\\work\\launch-deck.pdf", kind: "pdf" }));
  await act(async () => closeShow());
  await act(async () => showItem({ threadId: "t1", path: "C:\\work\\launch-deck.pdf", kind: "pdf" }));
  expect(shown?.path).toBe("C:\\work\\launch-deck.pdf");
});

const pdf: ShowItem = { threadId: "t1", path: "C:\\work\\launch-deck.pdf", kind: "pdf" };
const fresh: ShowItem = { ...pdf, threadId: "t5" };

it("the header button opens Media with nothing shown, the last file after one, and closes again", async () => {
  await render("t5", []);
  await act(async () => togglePane("t5"));
  expect([shown, media]).toEqual([null, "t5"]);
  await act(async () => togglePane("t5"));
  expect([shown, media]).toEqual([null, null]);
  await act(async () => showItem(fresh));
  await act(async () => closeShow());
  await act(async () => togglePane("t5"));
  expect([shown, media]).toEqual([fresh, null]);
  await act(async () => togglePane("t5"));
  expect([shown, media]).toEqual([null, null]);
  await act(async () => togglePane("t6"));
  expect([shown, media]).toEqual([null, "t6"]);
});

it("switching tabs keeps the shown file for Show", async () => {
  await render("t1", []);
  await act(async () => showItem(pdf));
  await act(async () => showMedia("t1"));
  expect([shown, media]).toEqual([pdf, "t1"]);
  await act(async () => showItem(pdf));
  expect([shown, media]).toEqual([pdf, null]);
});

it("does not open on its own over the Media tab", async () => {
  await render("t1", [user("u1")]);
  await act(async () => showMedia("t1"));
  await render("t1", [user("u1"), deck]);
  expect([shown, media]).toEqual([null, "t1"]);
});
