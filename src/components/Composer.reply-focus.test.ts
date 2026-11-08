import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const focusState = vi.hoisted(() => {
  const bots: Bot[] = [];
  return { botId: "", bots, dispatch: vi.fn() };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: vi.fn(async () => ({})),
    useStore: () => ({
      state: {
        acceptedSends: {},
        bots: focusState.bots,
        composerFocusBotId: focusState.botId,
        instances: [],
        pendingQueued: {},
      },
      dispatch: focusState.dispatch,
    }),
  };
});

import { Composer } from "./Composer";
import { api, type Bot, type Message } from "@/state/store";

const replyMessage: Message = { id: "m1", role: "bot", kind: "text", text: "hi", at: 0 };

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  focusState.botId = "";
  focusState.bots = [];
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function mount(replyTo: Message | null, focusBlocked = false, locked = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(Composer, { replyTo, focusBlocked, locked }));
  });
  const textarea = host.querySelector("[data-orbit-composer]");
  if (!(textarea instanceof HTMLElement) || textarea.tagName !== "TEXTAREA") {
    throw new Error("composer input did not render");
  }
  return textarea;
}

async function typeDraft(textarea: HTMLTextAreaElement) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "half a thought");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  textarea.setSelectionRange(2, 5);
}

describe("composer reply focus", () => {
  it("focuses at the draft end when empty frame space is clicked", async () => {
    const textarea = await mount(null) as HTMLTextAreaElement;
    await typeDraft(textarea);
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    await act(async () => frame.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it("focuses from an empty lower-row child", async () => {
    const textarea = await mount(null);
    const row = host!.querySelector("[data-orbit-composer-frame] button")!.parentElement!;
    await act(async () => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.activeElement).toBe(textarea);
  });

  it("leaves textarea clicks and selection drags alone", async () => {
    const textarea = await mount(null) as HTMLTextAreaElement;
    await typeDraft(textarea);
    textarea.focus();
    textarea.setSelectionRange(2, 5);
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    await act(async () => {
      textarea.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      frame.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(5);
  });

  it("preserves selection until an empty-space press becomes a click", async () => {
    const textarea = await mount(null) as HTMLTextAreaElement;
    await typeDraft(textarea);
    textarea.focus();
    textarea.setSelectionRange(2, 5);
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    await act(async () => frame.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(5);
  });

  it("leaves attach clicks on nested icons alone", async () => {
    const textarea = await mount(null);
    const input = host!.querySelector('input[type="file"]') as HTMLInputElement;
    const pick = vi.spyOn(input, "click");
    const icon = host!.querySelector("[data-orbit-composer-frame] button svg")!;
    await act(async () => icon.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(pick).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(textarea);
  });

  it.each(["button", "a", "input", "select", "textarea"])("does not focus through an interactive %s", async (tag) => {
    const textarea = await mount(null);
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    const control = document.createElement(tag);
    frame.append(control);
    await act(async () => control.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.activeElement).not.toBe(textarea);
  });

  it("does not force focus while locked", async () => {
    const textarea = await mount(null, false, true);
    const focus = vi.spyOn(textarea, "focus");
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    await act(async () => frame.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not force focus during an approval", async () => {
    const textarea = await mount(null);
    const bot: Bot = {
      id: "approval", threadId: "approval-thread", name: "Approval", title: "", description: "",
      notifications: false, color: "blue", unread: false,
      modelSelection: { instanceId: "claude", model: "claude" },
      messages: [{ id: "approval", role: "bot", kind: "options", text: "", at: 0,
        card: { title: "Approve", subtitle: "Run command", options: [], requestId: "request", tool: "Bash" } }],
    };
    await act(async () => root!.render(createElement(Composer, { bot })));
    const focus = vi.spyOn(textarea, "focus");
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    await act(async () => frame.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("prevents touch blur and focuses once on the click", async () => {
    const textarea = await mount(null);
    const focus = vi.spyOn(textarea, "focus");
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "pointerType", { value: "touch" });
    await act(async () => {
      frame.dispatchEvent(down);
      expect(focus).not.toHaveBeenCalled();
      frame.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(down.defaultPrevented).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("leaves a right press alone", async () => {
    const textarea = await mount(null);
    const frame = host!.querySelector("[data-orbit-composer-frame]")!;
    const down = new MouseEvent("pointerdown", { button: 2, bubbles: true, cancelable: true });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    await act(async () => {
      frame.dispatchEvent(down);
      frame.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(down.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("requests prewarm again on later focus and typing", async () => {
    const textarea = await mount(null);
    const bot: Bot = {
      id: "prewarm", threadId: "prewarm-thread", name: "Prewarm", title: "", description: "",
      notifications: false, color: "blue", unread: false, messages: [],
      modelSelection: { instanceId: "grok", model: "grok" },
    };
    await act(async () => root!.render(createElement(Composer, { bot })));
    await act(async () => textarea.focus());
    expect(api).toHaveBeenCalledWith("/api/bots/prewarm/prewarm", { method: "POST" });
    vi.mocked(api).mockClear();
    await act(async () => { textarea.blur(); textarea.focus(); });
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () => root!.render(createElement(Composer, { bot: { ...bot, id: "other" } })));
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true })));
    expect(api).toHaveBeenLastCalledWith("/api/bots/other/prewarm", { method: "POST" });
  });

  it("focuses the input when a reply target is selected", async () => {
    const textarea = await mount(null);
    expect(document.activeElement).not.toBe(textarea);

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: false }));
    });

    expect(document.activeElement).toBe(textarea);
  });

  it("keeps mobile replies unfocused until the input is tapped", async () => {
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...matchMedia(query), matches: query === "(pointer: coarse)" }));
    const textarea = await mount(null);
    await act(async () => root!.render(createElement(Composer, { replyTo: replyMessage })));

    expect(document.activeElement).not.toBe(textarea);
    await act(async () => textarea.focus());
    expect(document.activeElement).toBe(textarea);
  });

  it("consumes mobile chat focus requests without opening the keyboard", async () => {
    const matchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...matchMedia(query), matches: query === "(pointer: coarse)" }));
    const textarea = await mount(null);
    const bot: Bot = {
      id: "mobile", threadId: "mobile-thread", name: "Mobile", title: "", description: "",
      notifications: false, color: "blue", unread: false, messages: [],
      modelSelection: { instanceId: "grok", model: "grok" },
    };
    focusState.botId = bot.id;
    await act(async () => root!.render(createElement(Composer, { bot })));

    expect(document.activeElement).not.toBe(textarea);
    expect(focusState.dispatch).toHaveBeenCalledWith({ type: "composerFocused", botId: bot.id });
    expect(api).toHaveBeenCalledWith("/api/bots/mobile/prewarm", { method: "POST" });
  });

  // a failed send restores replyTo, which re-fires this long after the click
  it("leaves focus alone while a modal or the palette holds it", async () => {
    const textarea = await mount(null);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const inside = document.createElement("button");
    dialog.append(inside);
    document.body.append(dialog);
    inside.focus();

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: false }));
    });

    expect(document.activeElement).toBe(inside);
    expect(document.activeElement).not.toBe(textarea);
    dialog.remove();
  });

  // room setup and a pending approval both disable the textarea, and a
  // disabled input cannot take focus
  it("focuses once the composer unlocks with the reply still selected", async () => {
    const textarea = await mount(replyMessage, false, true);
    expect(document.activeElement).not.toBe(textarea);

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: false, locked: false }));
    });

    expect(document.activeElement).toBe(textarea);
  });

  it("leaves focus alone when the composer is focus-blocked", async () => {
    const textarea = await mount(null, true);

    await act(async () => {
      root!.render(createElement(Composer, { replyTo: replyMessage, focusBlocked: true }));
    });

    expect(document.activeElement).not.toBe(textarea);
  });
});

describe("composer draft caret", () => {
  const bot: Bot = {
    id: "caret", threadId: "caret-thread", name: "Caret", title: "", description: "",
    notifications: false, color: "blue", unread: false, messages: [],
    modelSelection: { instanceId: "grok", model: "grok" },
  };

  async function restore(draft: string) {
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem("omb-drafts", JSON.stringify({ "bot:caret:caret-thread": draft }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(Composer, { bot })));
    return host.querySelector("textarea")!;
  }

  afterEach(() => {
    localStorage.removeItem("omb-drafts");
    vi.unstubAllGlobals();
  });

  it("opens a chat with the caret at the end of its restored draft", async () => {
    focusState.botId = bot.id;
    const textarea = await restore("half a thought");
    expect(textarea.value).toBe("half a thought");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("half a thought".length);
    expect(textarea.selectionEnd).toBe("half a thought".length);
  });

  it("reopens the @mention picker for a draft that ends mid-tag", async () => {
    focusState.bots = [bot, { ...bot, id: "pokkey", threadId: "pokkey-thread", name: "Pokkey" }];
    await restore("ask @Pok");
    expect(host!.querySelector('[role="option"]')?.textContent).toContain("Pokkey");
  });
});

describe("composer approval chip", () => {
  it("leaves the approval mode out of the composer", async () => {
    await mount(null);
    const bot: Bot = {
      id: "chip", threadId: "chip-thread", name: "Chip", title: "", description: "",
      notifications: false, color: "blue", unread: false, messages: [],
      modelSelection: { instanceId: "grok", model: "grok" },
    };
    await act(async () => root!.render(createElement(Composer, { bot })));
    expect(host!.textContent).not.toMatch(/Ask for approval|Auto mode/);
    expect(host!.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });
});
