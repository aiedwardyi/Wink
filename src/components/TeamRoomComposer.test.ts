// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { uploadAttachment } from "@/lib/composer-attachments";
import { getDraft, setDraft, setDraftAttachments } from "@/lib/drafts";
import type { JoinedView, TeamRoom } from "@/lib/team-rooms";

import { JoinedRoomView } from "./JoinedRoomView";
import { TeamRoomView } from "./TeamRoomView";

const joined = vi.hoisted(() => ({ view: null as (JoinedView & { entries: [] }) | null }));
vi.mock("@/lib/joined-rooms", () => ({ useJoinedRoom: () => joined.view }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { connected: true } }), formatTime: () => "" }));

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
    expect(host.textContent).toContain("board.png");
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

  it("shows the existing type refusal when the dropped upload is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: "file-type" }, 415)));
    await render();
    await drag("drop", [file("program.exe", "application/octet-stream")]);
    await send();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This kind of file can't be shared.");
    expect(host.textContent).toContain("program.exe");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses the picker size and count refusals without uploading", async () => {
    await render();
    const large = file("large.txt");
    Object.defineProperty(large, "size", { value: 10 ** 12 });
    await drag("drop", [large]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("large.txt is too big to send.");
    await drag("drop", Array.from({ length: 11 }, (_, at) => file(`${at}.txt`)));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Up to 10 files per message.");
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

  it.each(["offline", "removed", "left", "gone", "missing"])("has no drop intake when the paperclip is absent: %s", async (phase) => {
    await render(phase === "missing" ? "host" : "joined");
    await drag("dragenter", []);
    expect(host.textContent).toContain("Drop to attach files");
    if (phase === "offline") joined.view!.link = "offline";
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
    expect(host.textContent).toContain("clipboard.png");
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
    const picker = host.querySelector('input[type="file"]')!;
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

  it.each(["host", "joined"])("restores the %s draft and files after a bot switch, isolates room B, and clears on send", async (side) => {
    await render(side);
    await type("Room A draft");
    const picker = host.querySelector('input[type="file"]')!;
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

describe("room focus", () => {
  it.each(["host", "joined"])("focuses the %s composer on desktop", async (side) => {
    await render(side);
    expect(document.activeElement).toBe(box());
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
