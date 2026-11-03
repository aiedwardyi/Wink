// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, Message } from "@/state/store";

const mock = vi.hoisted(() => ({ state: null as AppState | null, dispatch: vi.fn(), dictation: false }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: mock.state!, dispatch: mock.dispatch }),
  useStoreDispatch: () => mock.dispatch,
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DesktopCapabilities")>();
  return { ...actual, useDesktopCapabilities: () => ({ capabilities: { host: { platform: "win32" }, dictation: { available: mock.dictation } }, ready: true }) };
});

import { initialState } from "@/state/store";
import { composeMessage, splitAttachedImages } from "@/lib/composer-attachments";
import { botDraftId, rememberFailedComposerSend, setDraft } from "@/lib/drafts";
import { applyLocale } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";
import { startCall, endCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { roomTranscriptRows } from "@/lib/room-transcript";
import { SIDEBAR_SIDE_KEY } from "@/lib/sidebar-preferences";
import { Bubble, bubbleBot, versionProps } from "./ChatBubble";
import { ChatMarkdown } from "./ChatMarkdown";
import { Composer } from "./Composer";
import { CallOverlay } from "./CallView";
import { GroupCallOverlay } from "./GroupCallView";
import { Sidebar } from "./Sidebar";
import { Transcript } from "./GroupView";
import { PluginsPanel } from "./PluginsPanel";

const bot: Bot = {
  id: "ada", threadId: "ada-thread", name: "Ada", title: "", description: "", notifications: false,
  color: "blue", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude" },
};
const group: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: [bot.id], bulletin: "",
  defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1, messages: [],
};
const approval: Message = {
  id: "approval", kind: "options", role: "bot", at: 2,
  card: { title: "Approval needed", subtitle: "Run the build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" },
};
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  mock.state = { ...initialState, bots: [bot], groups: [group], hydrated: true };
  mock.dispatch.mockClear();
  mock.dictation = false;
  localStorage.clear();
  applyLocale("en");
  applySkin("wink");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  endCall();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.ogb;
});

const render = async (element: ReactElement) => { await act(async () => root.render(element)); };
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};
const button = (name: string, scope: ParentNode = document) => [...scope.querySelectorAll("button")].find((node) => node.textContent === name || node.getAttribute("aria-label") === name);
const space = async (target: EventTarget, prevented = false) => {
  const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
  if (prevented) event.preventDefault();
  await act(async () => { target.dispatchEvent(event); });
  return event;
};

it("C1 edits display text while preserving escaped attachment metadata and a single copy of pasted content", async () => {
  const text = composeMessage("Review this", [
    { id: "i", kind: "image", path: 'C:\\photos\\a&b.png', name: "a&b.png", size: 5, mime: "image/png" },
    { id: "f", kind: "file", path: 'C:\\files\\a&b.txt', name: 'a"<b>.txt', size: 5, type: "text/plain" },
    { id: "p", kind: "paste", text: "pasted content", lines: 1, size: 14 },
  ]);
  const message: Message = { id: "u1", kind: "text", role: "user", at: 1, text };
  const submit = vi.fn();
  await render(createElement(Bubble, {
    ...bubbleBot(bot), ...versionProps([message], message), message, pinned: false, editing: true, isLastBotText: false,
    onStartEdit: vi.fn(), onCancelEdit: vi.fn(), onSubmitEdit: submit, onReply: vi.fn(), onMessageMenu: vi.fn(),
  }));
  const editor = host.querySelector("textarea")!;
  expect(editor.value).toBe("Review this\n\npasted content");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "Updated\n\npasted content");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Send"));
  const sent = submit.mock.calls[0][1] as string;
  expect(splitAttachedImages(sent)).toMatchObject({ display: "Updated\n\npasted content", images: ['C:\\photos\\a&b.png'], files: [{ path: 'C:\\files\\a&b.txt', name: 'a"<b>.txt', size: 5 }] });
  expect(sent).toContain('name="a&quot;&lt;b&gt;.txt" size="5" type="text/plain"');
  expect(sent.match(/pasted content/g)).toHaveLength(1);
});

it("C2 keeps an unknown cold inventory unavailable and retries, then retains a prior snapshot on failure", async () => {
  let unavailable = true;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (String(input).includes("/catalog")) return Response.json({ configured: true, source: "api", mode: "managed", cards: [{ slug: "github", label: "GitHub", blurb: "Code", logo: null, domain: null }] });
    if (unavailable) throw new Error("offline");
    return Response.json({ services: { github: { connected: true, accounts: [{ id: "account", status: "ACTIVE" }] } } });
  }));
  await render(createElement(PluginsPanel));
  expect(button("Unavailable")?.disabled).toBe(true);
  await click(button("Connected"));
  expect(host.textContent).toContain("Couldn’t load connected apps");
  expect(host.textContent).not.toContain("No connected apps yet");
  unavailable = false;
  await click(button("Retry"));
  expect(host.textContent).toContain("GitHub");
  unavailable = true;
  await click(host.querySelector('button[title="Refresh connection status"]'));
  expect(host.textContent).toContain("GitHub");
  expect(host.textContent).toContain("Showing the last known connections");
});

it("C3 sends to a desktop terminal with sharing off and hides the control with sharing on or no bridge", async () => {
  const readBot = vi.fn(async () => ({ state: "ready", sessionId: "session", generation: 1, cwd: "C:\\work" }));
  const sendBot = vi.fn(async () => ({}));
  window.ogb = { terminal: { readBot, sendBot } } as unknown as NonNullable<Window["ogb"]>;
  setDraft(localStorage, botDraftId(bot.id, bot.threadId), "terminal command");
  await render(createElement(Composer, { bot: { ...bot, shareTerminalWithChat: false } }));
  await click(button("Send to terminal"));
  expect(readBot).toHaveBeenCalledWith(bot.id);
  await click(button("Send to terminal", document.querySelector('[role="dialog"]')!));
  expect(sendBot).toHaveBeenCalledWith(bot.id, { sessionId: "session", generation: 1, text: "terminal command" });
  setDraft(localStorage, botDraftId(bot.id, bot.threadId), "another command");
  await render(createElement(Composer, { key: "sharing", bot: { ...bot, shareTerminalWithChat: true } }));
  expect(button("Send to terminal")).toBeUndefined();
  delete window.ogb;
  await render(createElement(Composer, { key: "browser", bot: { ...bot, shareTerminalWithChat: false } }));
  expect(button("Send to terminal")).toBeUndefined();
});

it("C4 blocks approval sends, retries and attachment intake, and stops active dictation", async () => {
  const draftId = botDraftId(bot.id, bot.threadId);
  setDraft(localStorage, draftId, "draft waiting for approval");
  rememberFailedComposerSend(draftId, { sendId: "failed", text: "failed draft", requestText: "failed draft", threadId: bot.threadId });
  await render(createElement(Composer, { bot: { ...bot, messages: [approval] } }));
  expect(host.querySelector("textarea")?.disabled).toBe(true);
  expect(button("Send message")).toBeUndefined();
  expect(button("Attach a file")).toBeUndefined();
  expect(button("Retry")?.disabled).toBe(true);
  expect([...host.querySelectorAll<HTMLInputElement>('input[type="file"]')].every((input) => input.disabled)).toBe(true);
  const fileDrop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(fileDrop, "dataTransfer", { value: { types: ["Files"], files: [new File(["hello"], "note.txt", { type: "text/plain" })] } });
  await act(async () => { window.dispatchEvent(fileDrop); });
  expect(fileDrop.defaultPrevented).toBe(true);
  expect(host.textContent).not.toContain("note.txt");
  await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })));
  expect(mock.dispatch.mock.calls.some(([action]) => action.type === "send")).toBe(false);
  const speechStop = vi.fn(async () => {});
  window.ogb = {
    speechStart: vi.fn(async () => {}), speechStop,
    onSpeechTranscript: () => () => {}, onSpeechEnd: () => () => {},
  } as unknown as NonNullable<Window["ogb"]>;
  mock.dictation = true;
  await render(createElement(Composer, { key: "mic", bot: { ...bot, id: "mic", threadId: "mic-thread" } }));
  await click(button("Start dictation"));
  await render(createElement(Composer, { key: "mic", bot: { ...bot, id: "mic", threadId: "mic-thread", messages: [approval] } }));
  expect(speechStop).toHaveBeenCalled();
  expect(button("Start dictation")).toBeUndefined();
  expect(button("Stop dictation")).toBeUndefined();
});

it("C5 reserves speech interruption for an unhandled Space outside controls and modals in both call views", async () => {
  vi.spyOn(speaker, "isSpeaking").mockReturnValue(true);
  const stop = vi.spyOn(speaker, "stop").mockImplementation(() => {});
  for (const room of [false, true]) {
    await act(async () => startCall(room ? group.id : bot.id));
    await render(room ? createElement(GroupCallOverlay, { group, members: [bot] }) : createElement(CallOverlay, { bot }));
    stop.mockClear();
    for (const html of ['<input>', '<textarea></textarea>', '<button><span>Save</span></button>', '<div contenteditable="true">Edit</div>', '<a href="#">Link</a>', '<div role="switch">Switch</div>']) {
      const control = document.createElement("div");
      control.innerHTML = html;
      document.body.append(control);
      const event = await space(control.querySelector("span") ?? control.firstElementChild!);
      expect.soft(event.defaultPrevented).toBe(false);
      control.remove();
    }
    await space(window, true);
    const modal = document.body.appendChild(document.createElement("div"));
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    await space(window);
    modal.remove();
    expect(stop).not.toHaveBeenCalled();
    expect((await space(window)).defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    await render(createElement("div"));
    endCall();
  }
});

it("C6 removes URL metadata before decoding raw local file links and preserves encoded filename characters", async () => {
  const openFile = vi.fn(async () => ({ ok: true }));
  window.ogb = { openFile } as unknown as NonNullable<Window["ogb"]>;
  const paths = [
    ["C:/work/report.md#L42", "C:/work/report.md"],
    ["C:/work/report.md?download=1", "C:/work/report.md"],
    ["C:%5Cwork%5Creport.md#L42", "C:\\work\\report.md"],
    ["/tmp/a%23b%3Fc.md#L2", "/tmp/a#b?c.md"],
    ["file:///C:/work/a%23b.md?download=1", "C:/work/a#b.md"],
  ];
  for (const [href, expected] of paths) {
    await render(createElement(ChatMarkdown, { text: `[Open file](${href})` }));
    await click(button("Open file"));
    expect(openFile).toHaveBeenLastCalledWith(expected, undefined);
  }
});

it("C7 portals bot menus and both section pickers outside the transformed right phone drawer", async () => {
  localStorage.setItem(SIDEBAR_SIDE_KEY, "right");
  await render(createElement(Sidebar, { open: true, onClose: vi.fn() }));
  expect(host.querySelector("aside")?.className).toContain("max-md:right-0");
  const context = async (selector: string) => {
    const row = host.querySelector(`${selector} [role="button"], ${selector} > button`)!;
    expect(row).toBeTruthy();
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 330, clientY: 220 })));
  };
  await context('[data-sidebar-row-kind="bot"]');
  expect(document.querySelector("[data-bot-menu]")?.parentElement).toBe(document.body);
  await click(button("Move to section", document.querySelector("[data-bot-menu]")!));
  expect(document.querySelector("[data-section-picker]")?.parentElement).toBe(document.body);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await context('[data-sidebar-row-kind="group"]');
  await click(button("Move to section", document.querySelector("[data-room-menu]")!));
  const pickers = [...document.querySelectorAll("[data-section-picker]")];
  expect(pickers.length).toBeGreaterThan(0);
  expect(pickers.every((picker) => picker.parentElement === document.body)).toBe(true);
});

it("C8 includes room compaction rows and renders the shared divider in terminal skins", async () => {
  const message: Message = {
    id: "compact", kind: "compaction", role: "bot", at: 1,
    compaction: { v: 1, summary: "Kept the launch plan.", coveredThroughId: "m10", firstKeptId: "m11", contextWindow: 200_000, estimatedTokensBefore: 180_000, sourceMessageCount: 40 },
  };
  expect.soft(roomTranscriptRows([{ kind: "message", message }], { showToolCalls: false })[0].visible).toBe(true);
  applySkin("logfile");
  await render(createElement(Transcript, { group: { ...group, messages: [message] }, members: [bot], messages: [message], transcript: [message], streamingMessage: null, dock: null, workers: [], onReply: vi.fn(), onMessageMenu: vi.fn() }));
  expect(host.querySelector(".term-summary")?.textContent).toContain("Picked up from your saved summary");
});
