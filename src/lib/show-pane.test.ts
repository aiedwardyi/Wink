// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import * as usageStats from "./usage-stats";
import { paneKind } from "./open-file";
import { autoShowStep, closeShow, PANE_TAB_KEY, picturedReplies, showableLinks, showItem, showKind, showMap, showMedia, showTimeline, togglePane, useAutoShow, useMapThread, useMediaThread, usePanePulse, useShowItem, type AutoShow, type ShowItem } from "./show-pane";

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

it("shows plain text in the pane on a click, never on its own", () => {
  expect(["notes.txt", "NOTES.TXT", "a.png", "b.docx", ".txt"].map(paneKind)).toEqual(["text", "text", "image", null, null]);
  expect(showKind("notes.txt")).toBeNull();
  expect(showableLinks("[notes.txt](C:\\w\\notes.txt)")).toEqual([]);
});

it("marks the replies of a turn that already put a picture in the chat", () => {
  const picture = (id: string, botId?: string): Message => ({ id, role: "bot", kind: "screen", image: `${id}.png`, shown: true, at: 2, ...(botId ? { from: { botId, name: botId, color: "blue" } } : {}) });
  const said = (id: string, botId: string): Message => ({ ...bot(id, "[dog.png](C:\\w\\dog.png)"), from: { botId, name: botId, color: "blue" } });
  expect(picturedReplies([user("u1"), bot("b1", "On it."), picture("p1"), bot("b2", "Saved to [dog.png](C:\\w\\dog.png)."), user("u2"), bot("b3", "[cat.png](C:\\w\\cat.png)")])).toEqual({ pictured: new Set(["b1", "b2"]), tailPictures: new Set() });
  expect(picturedReplies([user("u1"), picture("p1", "alpha"), said("b1", "beta"), said("b2", "alpha")])).toEqual({ pictured: new Set(["b2"]), tailPictures: new Set(["alpha"]) });
  expect(picturedReplies([user("u1"), { ...user("s1"), role: "bot", kind: "screen", png: "AAAA" }, bot("b1", "ok")])).toEqual({ pictured: new Set(), tailPictures: new Set() });
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
    { messages: [...turn, deck, page, user("u2"), bot("b4", "[again.html](C:\\work\\again.html)")] },
  ])).toEqual([null, "C:\\work\\launch-deck.pdf", null, null, "C:\\work\\again.html"]);
});

it("never opens a picture on its own, and opens the page or PDF handed over with one", () => {
  const turn = [user("u1")];
  const dog = bot("b5", "Here: [dog.png](C:\\work\\dog.png)");
  const both = bot("b6", "[deck.pdf](C:\\work\\deck.pdf) and [dog.jpg](C:\\work\\dog.jpg)");
  expect(walk([{ messages: turn }, { messages: [...turn, dog] }, { messages: [...turn, dog, both] }])).toEqual([null, null, "C:\\work\\deck.pdf"]);
  expect(walk([{ messages: turn }, { messages: [...turn, page, dog] }])).toEqual([null, "C:\\work\\sync-flow.html"]);
  expect(walk([{ messages: turn }, { messages: [...turn, page] }, { messages: [...turn, page, dog] }])).toEqual([null, "C:\\work\\sync-flow.html", null]);
});

let host: HTMLElement;
let root: Root;
let shown: ShowItem | null = null;
let media: string | null = null;
let map: string | null = null;

function Probe({ thread, messages, free }: { thread: string; messages: Message[]; free: boolean }) {
  useAutoShow(thread, messages, free);
  shown = useShowItem();
  media = useMediaThread();
  map = useMapThread();
  return null;
}

const render = (thread: string, messages: Message[], free = true) => act(async () => root.render(createElement(Probe, { thread, messages, free })));

let served = 206;

beforeEach(() => {
  served = 206;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: served })));
  host = document.createElement("div");
  root = createRoot(host);
  shown = null;
  media = null;
  map = null;
});
afterEach(() => { act(() => root.unmount()); act(() => closeShow()); localStorage.clear(); vi.unstubAllGlobals(); });

it("opens a new file in the open chat, and stays shut after the user closes it this turn", async () => {
  const turn = [user("u1")];
  await render("t1", turn);
  await render("t1", [...turn, deck]);
  expect(shown).toEqual({ threadId: "t1", path: "C:\\work\\launch-deck.pdf", kind: "pdf" });
  await act(async () => closeShow());
  await render("t1", [...turn, deck, page]);
  expect(shown).toBeNull();
});

it("stays shut for a new page this PC cannot serve", async () => {
  served = 404;
  await render("t1", [user("u1")]);
  await render("t1", [user("u1"), page]);
  expect(shown).toBeNull();
});

function heldProbes() {
  const replies: Array<() => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => replies.push(() => done(new Response(null, { status: 206 }))))));
  return replies;
}

it("drops a pending probe once the user opens another tab", async () => {
  const replies = heldProbes();
  await render("t1", [user("u1")]);
  await render("t1", [user("u1"), page]);
  await act(async () => showMedia("t1"));
  await act(async () => { for (const reply of replies) reply(); });
  expect([shown, media]).toEqual([null, "t1"]);
});

it("never lets an older probe replace a newer file", async () => {
  const replies = heldProbes();
  await render("t1", [user("u1")]);
  await render("t1", [user("u1"), page]);
  await render("t1", [user("u1"), page, deck]);
  await act(async () => { replies[1]!(); });
  await act(async () => { replies[0]!(); });
  expect(shown?.path).toBe("C:\\work\\launch-deck.pdf");
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

it("the header button opens the tab last picked in each chat", async () => {
  await render("t1", []);
  await act(async () => showMap("t7"));
  await act(async () => showMedia("t8"));
  await act(async () => closeShow());
  await act(async () => togglePane("t7", "idle"));
  expect([shown, media, map]).toEqual([null, null, "t7"]);
  await act(async () => togglePane("t7", "idle"));
  await act(async () => togglePane("t8", "live"));
  expect([shown, media, map]).toEqual([null, "t8", null]);
});

it("with no pick the header button opens Map while a worker is live, else Media, and neither counts as a pick", async () => {
  await render("t1", []);
  await act(async () => togglePane("t10", "live"));
  expect([media, map]).toEqual([null, "t10"]);
  await act(async () => togglePane("t10", "live"));
  await act(async () => togglePane("t10", "idle"));
  expect([media, map]).toEqual(["t10", null]);
  await act(async () => togglePane("t10", "idle"));
  await act(async () => togglePane("t10", "live"));
  expect([media, map]).toEqual([null, "t10"]);
});

it("a room opens Media where it remembered Map, and never Map on its own", async () => {
  await render("t1", []);
  localStorage.setItem(PANE_TAB_KEY, JSON.stringify({ r1: "map" }));
  await act(async () => togglePane("r1"));
  expect([media, map]).toEqual(["r1", null]);
  await act(async () => closeShow());
  await act(async () => showMap("r2"));
  await act(async () => closeShow());
  await act(async () => togglePane("r2"));
  expect([media, map]).toEqual(["r2", null]);
});

it("a file that opens on its own is not a pick", async () => {
  await render("t9", [user("u1")]);
  await render("t9", [user("u1"), deck]);
  expect(shown?.path).toBe(pdf.path);
  await act(async () => closeShow());
  await act(async () => togglePane("t9", "live"));
  expect([shown, map]).toEqual([null, "t9"]);
});

it("keeps each chat's pick across a restart", async () => {
  await render("t1", []);
  await act(async () => showMap("t11"));
  await act(async () => showItem({ ...pdf, threadId: "t12" }));
  await act(async () => closeShow());
  vi.resetModules();
  const restarted = await import("./show-pane");
  let seen: unknown[] = [];
  const After = () => { seen = [restarted.useShowItem(), restarted.useMapThread()]; return null; };
  await act(async () => root.render(createElement(After)));
  await act(async () => restarted.togglePane("t11", "idle"));
  expect(seen).toEqual([null, "t11"]);
  await act(async () => restarted.togglePane("t12", "live"));
  expect(seen).toEqual([{ ...pdf, threadId: "t12" }, null]);
});

it("keeps the pick for the session when storage refuses it", async () => {
  const refuse = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await render("t1", []);
  await act(async () => showMap("t13"));
  await act(async () => closeShow());
  await act(async () => togglePane("t13", "idle"));
  expect(map).toBe("t13");
  refuse.mockRestore();
});

it("pulses only when a click lands on the file already showing", async () => {
  let pulses = -1;
  const Pulses = () => { pulses = usePanePulse(); return null; };
  await act(async () => root.render(createElement(Pulses)));
  const start = pulses;
  await act(async () => showItem({ ...pdf, threadId: "t14" }));
  expect(pulses).toBe(start);
  await act(async () => showItem({ ...pdf, threadId: "t14" }));
  expect(pulses).toBe(start + 1);
  await act(async () => showItem({ ...pdf, threadId: "t14", path: "C:\\w\\other.pdf" }));
  expect(pulses).toBe(start + 1);
});

it("never pulses under reduced motion, so the glow class cannot get stuck", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
  let pulses = -1;
  const Pulses = () => { pulses = usePanePulse(); return null; };
  await act(async () => root.render(createElement(Pulses)));
  const start = pulses;
  await act(async () => showItem({ ...pdf, threadId: "t16" }));
  await act(async () => showItem({ ...pdf, threadId: "t16" }));
  expect(pulses).toBe(start);
});

it("switches a link click to Show from the Map tab without pulsing", async () => {
  let seen: unknown[] = [];
  const Tabs = () => { seen = [useShowItem(), useMapThread(), usePanePulse()]; return null; };
  await act(async () => root.render(createElement(Tabs)));
  const start = seen[2];
  await act(async () => showItem({ ...pdf, threadId: "t15" }));
  await act(async () => showMap("t15"));
  expect(seen).toEqual([{ ...pdf, threadId: "t15" }, "t15", start]);
  await act(async () => showItem({ ...pdf, threadId: "t15" }));
  expect(seen).toEqual([{ ...pdf, threadId: "t15" }, null, start]);
});

it("counts Map and Timeline when they open, including a restored pane", () => {
  const track = vi.spyOn(usageStats, "trackScreen");
  closeShow();
  showMap("stats-test");
  showMap("stats-test");
  showTimeline("stats-test");
  closeShow();
  togglePane("stats-test", "idle");
  expect(track.mock.calls).toEqual([["map"], ["timeline"], ["timeline"]]);
  track.mockRestore();
});