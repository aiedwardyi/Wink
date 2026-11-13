// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { uploadAttachment } from "@/lib/composer-attachments";
import { getDraft, setDraft, setDraftAttachments } from "@/lib/drafts";
import { focusComposerOnActivation } from "@/lib/focus-composer";
import type { JoinedView, TeamRoom } from "@/lib/team-rooms";
import type { Message } from "@/state/store-types";

import { JoinedRoomView } from "./JoinedRoomView";
import { TeamRoomComposer } from "./TeamRoomComposer";
import { TeamRoomView } from "./TeamRoomView";

const joined = vi.hoisted(() => ({ view: null as (JoinedView & { entries: [] }) | null, dispatched: [] as unknown[] }));
vi.mock("@/lib/joined-rooms", () => ({ useJoinedRoom: () => joined.view }));
vi.mock("@/lib/room-files-state", () => ({ useRoomFilesState: () => ({ deleted: [], error: null }) }));
vi.mock("@/lib/room-translate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/room-translate")>(),
  useTranslationAvailable: () => false,
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { connected: true, bots: [], acceptedSends: {}, instances: [], pendingQueued: {} }, dispatch: (action: unknown) => joined.dispatched.push(action) }),
  formatTime: () => "",
}));

const group = {
  id: "g1", threadId: "t1", name: "Design team", memberIds: [], messages: [],
  hosted: { roomId: "r1" }, room: { name: "Design team", people: [] },
} as unknown as TeamRoom;

let host: HTMLDivElement;
let root: Root;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const file = (name: string, type = "text/plain") => new File(["notes"], name, { type });
const box = () => host.querySelector("textarea")!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => reply(path.includes("/files?") ? { file: { id: "uploaded" } } : { ok: true })));
  joined.view = {
    roomId: "r9", status: "joined", link: "live", me: { id: "p1", name: "Mina" },
    state: { roomName: "Design team", host: "Edward", people: [] }, entries: [],
  };
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  applyLocale("en");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(side = "host", missing = false) {
  await act(async () => root.render(side === "host"
    ? createElement(TeamRoomView, { group: missing ? { ...group, room: { missing: true } } as TeamRoom : group })
    : createElement(JoinedRoomView, { roomId: "r9" })));
}

it.each([
  ["en", "스타줌 is finishing another task, then answers here."],
  ["ko", "스타줌 다른 작업을 마치면 여기서 답해요."],
] as const)("shows the %s room wait until the bot starts", async (locale, text) => {
  applyLocale(locale);
  joined.view!.state!.teamBots = [{ id: "tb1", name: "스타줌", color: "blue", owner: "p1" }];
  joined.view!.myBots = [{ id: "tb1", botId: "b1", waiting: true }];
  await render("joined");
  expect(host.querySelector("[data-my-bot-turn]")!.textContent).toBe(text);
  expect(host.querySelector("[data-my-bot-turn]")!.className).not.toContain("text-danger");
  joined.view!.myBots = [{ id: "tb1", botId: "b1", working: true }];
  await render("joined");
  expect(host.textContent).not.toContain(text);
  joined.view!.myBots = [];
  await render("joined");
  expect(host.querySelector("[data-my-bot-turn]")).toBeNull();
});

async function drag(type: string, files: File[], types = ["Files"], target: EventTarget = host.querySelector("[data-team-room-transcript]")!) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files } });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

async function send() {
  await act(async () => box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })));
}

async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), text);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("room file drop", () => {
  it("attaches two files dropped on the hosted transcript and uploads through the room", async () => {
    await render();
    const files = [file("plan.txt"), file("board.png", "image/png")];
    await drag("drop", files);
    expect(host.textContent).toContain("plan.txt");
    expect(host.querySelector("img[alt='board.png']")).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    await send();
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([path]) => String(path).split("?")[0])).toEqual(["/api/rooms/r1/files", "/api/rooms/r1/files", "/api/rooms/r1/send"]);
    expect(calls.slice(0, 2).map(([, init]) => init?.body)).toEqual(files);
    expect(host.textContent).not.toContain("plan.txt");
  });

  it("attaches a file dropped on the joined room header", async () => {
    await render("joined");
    await drag("drop", [file("joined.txt")], ["Files"], host.querySelector("main > div")!);
    expect(host.textContent).toContain("joined.txt");
    await send();
    expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path).split("?")[0])).toEqual(["/api/joined/rooms/r9/files", "/api/joined/rooms/r9/send"]);
  });

  it("names the kinds a room takes when the dropped upload is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "file-type" }, 415)));
    await render();
    await drag("drop", [file("program.exe", "application/octet-stream")]);
    await send();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Only pictures, video, audio, PDF, zip, Office and text files can be shared.");
    expect(host.textContent).toContain("program.exe");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the picker size and count refusals without uploading", async () => {
    await render();
    const large = file("large.txt");
    Object.defineProperty(large, "size", { value: 10 ** 12 });
    await drag("drop", [large]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("large.txt is too big. Pictures can be up to 100 MB; other files up to 1 GB.");
    await drag("drop", Array.from({ length: 51 }, (_, at) => file(`${at}.txt`)));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Up to 50 files per message.");
    expect(host.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["en", "ko"] as const)("keeps the %s highlight across nested enters and clears it on drop", async (locale) => {
    applyLocale(locale);
    await render();
    const label = locale === "en" ? "Drop to attach files" : "파일을 놓아 첨부하세요";
    await drag("dragenter", []);
    await drag("dragenter", []);
    await drag("dragleave", []);
    expect(host.textContent).toContain(label);
    expect((await drag("dragover", [])).defaultPrevented).toBe(true);
    await drag("drop", [file("notes.txt")]);
    expect(host.textContent).not.toContain(label);
    expect(host.textContent).toContain("notes.txt");
  });

  it("ignores text and link drops", async () => {
    await render();
    expect((await drag("dragenter", [], ["text/plain"])).defaultPrevented).toBe(false);
    expect((await drag("drop", [], ["text/uri-list"])).defaultPrevented).toBe(false);
    expect(host.textContent).not.toContain("Drop to attach files");
    expect(box().value).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["removed", "left", "gone", "missing"])("has no drop intake when the paperclip is absent: %s", async (phase) => {
    await render(phase === "missing" ? "host" : "joined");
    await drag("dragenter", []);
    expect(host.textContent).toContain("Drop to attach files");
    if (phase === "removed" || phase === "left") joined.view!.status = phase;
    if (phase === "gone") joined.view = null;
    await render(phase === "missing" ? "host" : "joined", phase === "missing");
    await drag("drop", [file("blocked.txt")]);
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.textContent).not.toContain("Drop to attach files");
    expect(host.textContent).not.toContain("blocked.txt");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("already accepts an image pasted into the composer", async () => {
    await render();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file("clipboard.png", "image/png")] } });
    await act(async () => { box().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector("img[alt='clipboard.png']")).not.toBeNull();
    await send();
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain("/api/rooms/r1/files?name=clipboard.png");
  });
});

describe("room composer height", () => {
  it("grows a multiline draft to the bot cap and shrinks after send", async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return this.value.split("\n").length * 24 + 8;
    });
    await render();
    const oneLine = parseFloat(box().style.height) || 32;
    await type(Array.from({ length: 12 }, (_, at) => `한국어 메시지 ${at + 1}`).join("\n"));
    expect(parseFloat(box().style.height)).toBeGreaterThan(oneLine);
    expect(parseFloat(box().style.height)).toBe(24 * 6);
    await send();
    expect(box().value).toBe("");
    expect(parseFloat(box().style.height)).toBe(oneLine);
  });
});

describe("room drafts", () => {
  it.each(["host", "joined"])("keeps a pending %s upload blocked across navigation", async (side) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((path: string) => path.includes("/files?")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(reply({ ok: true }))));
    await render(side);
    await drag("drop", [file("pending.txt")]);
    await send();
    await act(async () => root.render(createElement("div", null, "Bot chat")));
    await render(side);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
    await send();
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => finish(reply({ file: { id: "uploaded" } })));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("pending.txt");
  });

  it.each(["host", "joined"])("sends a %s photo once when Send is tapped after switching chats mid-upload", async (side) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((path: string) => path.includes("/files?")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(reply({ ok: true }))));
    await render(side);
    await drag("drop", [file("photo.png", "image/png")]);
    const tap = () => act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
    await tap();
    await act(async () => root.render(createElement("div", null, "Bot chat")));
    await render(side);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
    await tap();
    await act(async () => finish(reply({ file: { id: "uploaded" } })));
    expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path).split("?")[0]).filter((path) => path.endsWith("/send"))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("photo.png");
  });

  it.each(["host", "joined"])("keeps a pending %s send blocked across navigation", async (side) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await render(side);
    await type("Only once");
    await send();
    await act(async () => root.render(createElement("div", null, "Bot chat")));
    await render(side);
    expect(box().value).toBe("");
    await type("Next");
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
    await send();
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => finish(reply({ ok: true })));
    expect(box().value).toBe("Next");
  });

  it("blocks duplicate Enter events before React renders the pending state", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await render();
    await type("Only once");
    await act(async () => {
      for (let i = 0; i < 2; i++) box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => finish(reply({ ok: true })));
  });

  it("reuses the send identity when retrying after navigation", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(reply({ error: "offline" }, 500))
      .mockResolvedValueOnce(reply({ ok: true })));
    await render();
    await type("Retry me");
    await send();
    await act(async () => root.render(createElement("div", null, "Bot chat")));
    await render();
    await send();
    const ids = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).sendId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(box().value).toBe("");
  });

  it("restores stored text and a re-pick chip after a reload", async () => {
    setDraft(localStorage, "g1", "Saved before reload");
    setDraftAttachments(localStorage, "g1", [uploadAttachment(file("reload.txt"))]);
    await render();
    expect(box().value).toBe("Saved before reload");
    expect(host.textContent).toContain("reload.txt");
    const repick = [...host.querySelectorAll("button")].find((button) => button.textContent === "Pick the file again to resume");
    expect(repick).toBeTruthy();
    await send();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => repick!.click());
    const picker = host.querySelector('input[type="file"]:not([multiple]):not([data-room-picture-input])')!;
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [file("reload.txt")], configurable: true });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await send();
    expect(getDraft(localStorage, "g1")).toBe("");
    expect(host.textContent).not.toContain("reload.txt");
  });

  it.each([false, true])("handles a send finishing after a switch with a newer draft: %s", async (edited) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await render();
    await type("Sent text");
    await send();
    await act(async () => root.render(createElement("div", null, "Bot chat")));
    await render();
    if (edited) await type("New draft");
    await act(async () => finish(reply({ ok: true })));
    expect(box().value).toBe(edited ? "New draft" : "");
    expect(getDraft(localStorage, "g1")).toBe(edited ? "New draft" : "");
  });

  it.each(["host", "joined"])("clears the %s box at send and puts it back only on failure", async (side) => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await render(side);
    await type("hello");
    await send();
    expect(box().value).toBe("");
    await act(async () => finish(reply({ error: "offline" }, 500)));
    expect(box().value).toBe("hello");
  });

  it("puts a failed send back ahead of what was typed since", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await render("joined");
    await type("hello");
    await send();
    await type("more");
    await act(async () => finish(reply({ error: "offline" }, 500)));
    expect(box().value).toBe("hello\n\nmore");
  });

  it("keeps a reply picked while an earlier send is pending", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const first = { id: "a", at: 1, role: "user", kind: "text", text: "first" } as Message;
    const clear = vi.fn();
    const composer = (replyTo: Message) => createElement(TeamRoomComposer, { name: "Design team", base: "/api/rooms/r1", draftId: "g1", replyTo, onClearReply: clear });
    await act(async () => root.render(composer(first)));
    await type("Sent text");
    await send();
    await act(async () => root.render(composer({ ...first, id: "b", text: "second" })));
    await act(async () => finish(reply({ ok: true })));
    expect(box().value).toBe("");
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(["host", "joined"])("restores the %s draft and files after a bot switch, isolates room B, and clears on send", async (side) => {
    await render(side);
    await type("Room A draft");
    const picker = host.querySelector('input[type="file"]:not([data-room-picture-input])')!;
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [file("draft.txt")], configurable: true });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => root.render(createElement("div", null, "Bot chat")));
    await render(side);
    expect(box().value).toBe("Room A draft");
    expect(host.textContent).toContain("draft.txt");
    await act(async () => root.render(createElement(TeamRoomView, { group: { ...group, id: "g2", hosted: { roomId: "r2" } } })));
    expect(box().value).toBe("");
    expect(host.textContent).not.toContain("draft.txt");
    await type("Room B draft");
    await render(side);
    expect(box().value).toBe("Room A draft");
    await send();
    await act(async () => root.render(createElement("div", null, "Bot chat")));
    await render(side);
    expect(box().value).toBe("");
    expect(host.textContent).not.toContain("draft.txt");
    await act(async () => root.render(createElement(TeamRoomView, { group: { ...group, id: "g2", hosted: { roomId: "r2" } } })));
    expect(box().value).toBe("Room B draft");
  });
});

describe("room mentions", () => {
  it("offers a teammate the room's bots and people", async () => {
    joined.view!.state = { roomName: "Design team", host: "Edward", people: [{ id: "p2", name: "Sora" }], bots: [{ id: "b1", name: "Wink", color: "blue" }] } as NonNullable<JoinedView["state"]>;
    await render("joined");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), "@");
      box().setSelectionRange(1, 1);
      box().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...host.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["WinkAgent", "EdwardPerson", "SoraPerson"]);
  });
});

describe("room bots", () => {
  it("gives the host no dashed + on a room with no bots: Add lives in Room details", async () => {
    await render();
    expect(host.querySelector(".border-dashed")).toBeNull();
    expect(host.querySelector('button[title="Manage members"]')).toBeNull();
  });

  it("gives a teammate no + even once the room has bots", async () => {
    joined.view!.state = { roomName: "Design team", host: "Edward", people: [], bots: [{ id: "b1", name: "Wink", color: "blue" }] } as NonNullable<JoinedView["state"]>;
    await render("joined");
    expect(host.querySelector('button[title="Manage members"]')).toBeNull();
  });
});

describe("room focus", () => {
  it("lets the sidebar refocus an already open room through the shared rule", async () => {
    await render();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const row = host.querySelector("button")!;
    row.focus();
    focusComposerOnActivation({ activatedElement: row });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(box());
  });

  it.each(["host", "joined"])("focuses the %s composer on desktop", async (side) => {
    await render(side);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(box());
  });

  it("keeps the joined box and its focus while the link blips, holding Send until it is back", async () => {
    await render("joined");
    box().focus();
    await type("안녕하세요");
    joined.view!.link = "offline";
    await render("joined");
    expect(document.activeElement).toBe(box());
    expect(box().value).toBe("안녕하세요");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Unavailable. Edward is offline.");
    expect(host.querySelector('[aria-label="Attach a file"]')).toBeNull();
    await drag("drop", [file("blocked.txt")]);
    await send();
    expect(box().value).toBe("안녕하세요");
    expect(host.textContent).not.toContain("blocked.txt");
    expect(fetch).not.toHaveBeenCalled();
    joined.view!.link = "live";
    await render("joined");
    expect(host.querySelector('[role="status"]')).toBeNull();
    await send();
    expect(vi.mocked(fetch).mock.calls.map(([path]) => String(path))).toEqual(["/api/joined/rooms/r9/send"]);
  });

  it.each(["en", "ko"])("says a room the host deleted is gone after Leave: %s", async (locale) => {
    applyLocale(locale as "en" | "ko");
    joined.view!.status = "left";
    (joined.view as JoinedView).gone = true;
    await render("joined");
    expect(host.textContent).toContain(locale === "en" ? "This room is gone." : "없어진 채팅방이에요.");
  });

  it("leaves the phone keyboard closed and handles a left room", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    await render();
    expect(document.activeElement).not.toBe(box());
    joined.view!.status = "left";
    await render("joined");
    expect(host.querySelector("textarea")).toBeNull();
  });
});

describe("joined room paging", () => {
  it("asks the room for older lines once when a teammate scrolls to the top", async () => {
    Object.assign(joined.view!, { hasMore: true, entries: [{ seq: 201, id: "e201", at: 1, author: { kind: "host", id: "host", name: "Edward" }, text: "line 201" }] });
    await render("joined");
    const pane = host.querySelector("[data-team-room-transcript]")!;
    await act(async () => pane.dispatchEvent(new Event("scroll")));
    await act(async () => pane.dispatchEvent(new Event("scroll")));
    expect(vi.mocked(fetch).mock.calls.map(([path, init]) => [path, init?.body])).toEqual([["/api/joined/rooms/r9/older", JSON.stringify({ before: 201 })]]);
  });
});

describe("room click to type", () => {
  const settle = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const click = async (target: Element) => {
    await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
    await settle();
  };
  const away = async () => {
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(box());
  };

  it.each(["host", "joined"])("focuses the %s composer on an empty transcript click", async (side) => {
    await render(side);
    await away();
    await click(host.querySelector("[data-team-room-transcript]")!);
    expect(document.activeElement).toBe(box());
  });

  it("focuses from the gap between messages", async () => {
    await render();
    await away();
    await click(host.querySelector('[role="log"]')!);
    expect(document.activeElement).toBe(box());
  });

  it("leaves buttons and links alone", async () => {
    await render();
    await away();
    const log = host.querySelector('[role="log"]')!;
    const button = log.appendChild(document.createElement("button"));
    const link = log.appendChild(document.createElement("a"));
    link.setAttribute("href", "https://example.com");
    await click(button);
    await click(link);
    expect(document.activeElement).not.toBe(box());
  });

  it("leaves a text selection alone", async () => {
    await render();
    await away();
    const log = host.querySelector('[role="log"]')!;
    log.textContent = "picked words";
    const range = document.createRange();
    range.selectNodeContents(log);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await click(log);
    expect(document.activeElement).not.toBe(box());
    window.getSelection()!.removeAllRanges();
  });

  it("stays out of the way on a phone", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    await render();
    await click(host.querySelector("[data-team-room-transcript]")!);
    expect(document.activeElement).not.toBe(box());
  });

  it.each(["host", "joined"])("gives the %s box the skin frame", async (side) => {
    await render(side);
    expect(box().closest("[data-orbit-composer-frame]")).not.toBeNull();
  });
});

describe("room image preview", () => {
  const urls = { made: [] as Blob[], revoked: [] as string[] };
  beforeEach(() => {
    urls.made = [];
    urls.revoked = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { urls.made.push(blob as Blob); return `blob:thumb-${urls.made.length}`; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => { urls.revoked.push(url); });
  });

  it.each(["host", "joined"])("shows an attached image as a %s thumbnail with a remove button", async (side) => {
    await render(side);
    await drag("drop", [file("board.png", "image/png")]);
    const thumb = host.querySelector<HTMLImageElement>("img[alt='board.png']");
    expect(thumb?.getAttribute("src")).toBe("blob:thumb-1");
    expect(thumb?.closest("[title='board.png']")?.className).toContain("w-[172px]");
    await act(async () => host.querySelector<HTMLElement>("[aria-label='Remove image']")!.click());
    expect(host.querySelector("img[alt='board.png']")).toBeNull();
    expect(urls.revoked).toContain("blob:thumb-1");
  });

  it("keeps a plain row for a file that is not a picture", async () => {
    await render();
    await drag("drop", [file("plan.txt")]);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("plan.txt");
  });
});

describe("room box is the 1:1 box", () => {
  it.each(["host", "joined"])("renders the shared %s composer", async (side) => {
    await render(side);
    expect(host.querySelector("[data-team-room] textarea[data-orbit-composer]")).toBe(box());
    expect(host.querySelector("[data-orbit-composer-host]")).not.toBeNull();
  });

  it("types from a press on the frame padding", async () => {
    await render();
    (document.activeElement as HTMLElement | null)?.blur();
    const frame = box().closest<HTMLElement>("[data-orbit-composer-frame]")!;
    await act(async () => {
      frame.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      frame.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(document.activeElement).toBe(box());
  });

  it("opens the attached image preview", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumb");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await render();
    await drag("drop", [file("board.png", "image/png")]);
    await act(async () => host.querySelector<HTMLElement>("[aria-label='Preview board.png']")!.click());
    expect(document.querySelector("[role='dialog'] img[src='blob:thumb']")).not.toBeNull();
  });

  it("offers room people in the @ list", async () => {
    await act(async () => root.render(createElement(TeamRoomView, { group: { ...group, room: { name: "Design team", people: [{ id: "p1", name: "Mina" }] } } as unknown as TeamRoom })));
    await type("hi @Mi");
    expect(host.querySelector("[role='listbox'] [role='option']")?.textContent).toContain("Mina");
  });

  it("sends with the 1:1 send button", async () => {
    await render();
    await type("hello");
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-label='Send message']")!.click());
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain("/api/rooms/r1/send");
  });
});

describe("room header", () => {
  const labels = () => [...host.querySelector("main")!.firstElementChild!.querySelectorAll("button")].map((each) => each.getAttribute("aria-label"));

  it("keeps only the name, the bell and the side pane, side pane last", async () => {
    await render();
    expect(labels()).toEqual(["Design team, Open room details", "Turn off alerts for this room", "Show and media"]);
  });

  it("gives a joined room only its name and bell", async () => {
    await render("joined");
    expect(labels()).toEqual(["Design team, Open room details", "Turn off alerts for this room"]);
  });

  it("opens Room details from the name", async () => {
    joined.dispatched.length = 0;
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>("[data-room-title]")!.click());
    expect(joined.dispatched).toEqual([{ type: "toggleSettings", open: true }]);
  });
});
