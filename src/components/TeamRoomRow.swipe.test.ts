// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";

import { TeamRoomTranscript } from "./TeamRoomRow";

const readiness = vi.hoisted(() => ({ instances: [] as unknown[], config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: readiness }),
}));

const lines: RoomLine[] = [
  { id: "mirror-1", entryId: "e1", at: 1, author: { kind: "person", id: "mina", name: "Mina Park" }, text: "자료를 정리했어요.\n함께 확인해 주세요.", files: [] },
  { id: "mirror-2", entryId: "e2", at: 2, author: { kind: "person", id: "daniel", name: "Daniel Cho" }, text: "The checklist is ready.", files: [] },
  { id: "mirror-3", entryId: "e3", at: 3, author: { kind: "host", id: "host", name: "Edward" }, text: "고마워요!", files: [] },
];
const onReply = vi.fn();
const translate = vi.fn(async () => new Response(JSON.stringify({ text: "I organized the materials." })));
const fetch = vi.fn((path: string) => path.endsWith("/entries/e1/translate")
  ? translate() : Promise.resolve(new Response(JSON.stringify({ available: true }))));
let host: HTMLDivElement;
let root: Root;
let time: number;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let phone: boolean;
const row = (id: string) => host.querySelector<HTMLElement>(`[data-mid="${id}"]`)!;
const bubble = (id: string) => row(id).querySelector<HTMLElement>("div.relative")!;
const content = (id: string) => row(id).querySelector<HTMLElement>("[data-team-room-content]")!;

function touch(type: string, target: Element, x: number, y = 200) {
  time += 16;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
}

async function swipe(id: string, from: number, to: number) {
  const target = content(id);
  await act(async () => {
    touch("touchstart", target, from);
    touch("touchmove", target, (from + to) / 2);
    touch("touchmove", target, to);
    touch("touchend", target, to);
    await wait(60);
  });
}

async function render() {
  await act(async () => root.render(createElement(TeamRoomTranscript, { onReply, lines, mine: (line) => line.author.kind === "host", base: "/api/rooms/r1", label: "Launch week" })));
  await act(async () => { await wait(0); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetch);
  fetch.mockClear();
  translate.mockClear();
  onReply.mockReset();
  time = 0;
  phone = true;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 392 });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("reduced-motion") ? false : query.includes("max-width") ? phone : query.includes("pointer: coarse"),
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList));
  applyLocale("en");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  applyLocale("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("room line swipe", () => {
  it("swipe right quotes that line in the composer", async () => {
    await render();
    await swipe("mirror-2", 100, 190);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply.mock.calls[0]![0]).toMatchObject({ id: "mirror-2", text: "The checklist is ready." });
  });

  it("swipe right replies on the host's own line too", async () => {
    await render();
    await swipe("mirror-3", 100, 190);
    expect(onReply.mock.calls[0]![0]).toMatchObject({ id: "mirror-3" });
  });

  it("swipe left translates, and swipe left again shows the original only", async () => {
    await render();
    await swipe("mirror-1", 300, 200);
    expect(translate).toHaveBeenCalledTimes(1);
    expect(content("mirror-1").querySelector("[data-room-translation]")?.textContent).toBe("I organized the materials.");
    expect(content("mirror-1").textContent).toContain("자료를 정리했어요.");
    await swipe("mirror-1", 300, 200);
    expect(content("mirror-1").querySelector("[data-room-translation]")).toBeNull();
    expect(content("mirror-1").textContent).toContain("자료를 정리했어요.");
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("own lines and lines without the translate button do not move left", async () => {
    await render();
    await swipe("mirror-3", 300, 200);
    await swipe("mirror-2", 300, 200);
    expect(translate).not.toHaveBeenCalled();
    expect(bubble("mirror-3").style.transform).toBe("");
    expect(bubble("mirror-2").style.transform).toBe("");
    expect(row("mirror-2").dataset.swipe).toBeUndefined();
  });

  it("a vertical drag scrolls and does nothing", async () => {
    await render();
    const target = content("mirror-2");
    await act(async () => {
      touch("touchstart", target, 100, 300);
      touch("touchmove", target, 106, 240);
      touch("touchmove", target, 200, 180);
      touch("touchend", target, 200, 180);
    });
    expect(onReply).not.toHaveBeenCalled();
  });

  it("a still hold opens the menu and a following lift replies nothing", async () => {
    await render();
    const target = content("mirror-2");
    await act(async () => {
      touch("touchstart", target, 100);
      await wait(600);
    });
    expect(document.querySelector("[data-message-menu]")).not.toBeNull();
    await act(async () => { touch("touchend", target, 100); });
    expect(onReply).not.toHaveBeenCalled();
  });

  it("a swipe never opens the menu, even if the finger then waits", async () => {
    await render();
    const target = content("mirror-2");
    await act(async () => {
      touch("touchstart", target, 100);
      touch("touchmove", target, 130);
      touch("touchmove", target, 190);
      await wait(700);
    });
    expect(document.querySelector("[data-message-menu]")).toBeNull();
    await act(async () => { touch("touchend", target, 190); await wait(60); });
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it("listens once on the list, passively, however many rows", async () => {
    const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
    await render();
    const touches = add.mock.calls.filter(([type]) => String(type).startsWith("touch"));
    expect(touches.map(([type]) => type)).toEqual(["touchstart", "touchmove", "touchend", "touchcancel"]);
    expect(touches.every(([, , options]) => (options as AddEventListenerOptions | undefined)?.passive)).toBe(true);
  });

  it("draws the swipe icons only while a swipe is on", async () => {
    await render();
    const icons = () => row("mirror-1").querySelectorAll(":scope > svg").length;
    expect(icons()).toBe(0);
    const target = content("mirror-1");
    await act(async () => { touch("touchstart", target, 100); touch("touchmove", target, 140); touch("touchmove", target, 190); });
    expect(icons()).toBe(2);
    await act(async () => { touch("touchend", target, 190); await wait(60); });
    expect(icons()).toBe(0);
  });

  it("attaches nothing at desktop width", async () => {
    phone = false;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
    await render();
    expect(add.mock.calls.filter(([type]) => String(type).startsWith("touch"))).toEqual([]);
    expect(row("mirror-2").style.touchAction).toBe("");
    await swipe("mirror-2", 100, 190);
    expect(onReply).not.toHaveBeenCalled();
  });
});
