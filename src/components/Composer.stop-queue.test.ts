// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pasteAttachment } from "@/lib/composer-attachments";
import { getDraftAttachments, getRoomHolds, setDraftAttachments } from "@/lib/drafts";
import { STOP_AFTER_SEND_MS } from "@/lib/send-hold";
import { StoreProvider, useStore, type Bot, type Group } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot: Bot = {
  id: "bot-q", threadId: "thread-q", name: "Scout", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy: true, activity: "working",
  modelSelection: { instanceId: "waits", model: "m" },
};
const room: Group = {
  id: "room-q", threadId: "room-thread-q", name: "Room", memberIds: [bot.id], bulletin: "",
  defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1, messages: [],
  working: true, busyBotId: bot.id,
};

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(target: { bot?: Bot; group?: Group }, request?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") {
      return Response.json({ bots: [target.bot ?? bot], groups: target.group ? [target.group] : [], computerControl: {} });
    }
    if (path === "/api/instances") return Response.json({ instances: [{ instanceId: "waits", capabilities: {} }] });
    const response = request?.(path, init);
    if (response) return response;
    if (init?.method !== "POST") return Response.json({ error: "not in this test" }, { status: 404 });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    posts.push({ path, body });
    if (path === `/api/bots/${bot.id}/messages`) {
      return Response.json({ ok: true, queued: true, queueId: `q-${body.text}`, threadId: bot.threadId }, { status: 202 });
    }
    if (path === `/api/bots/${bot.id}/interrupt`) {
      const sent = posts.filter((post) => post.path.endsWith("/messages")).map((post) => post.body);
      return Response.json({
        ok: true,
        returned: sent.map((send) => ({ threadId: bot.threadId, queueId: `q-${send.text}`, sendId: send.sendId, text: send.text })),
      });
    }
    return Response.json({ ok: true });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store!: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    return createElement(Composer, target.group ? { group: target.group, members: [bot] } : { bot: store.state.bots[0] ?? target.bot ?? bot });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
  await vi.waitFor(() => expect(store.state.instances).toHaveLength(1));
  const box = host.querySelector("textarea")!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async (value: string, after = false) => {
    await type(value);
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, ctrlKey: after, bubbles: true, cancelable: true })));
  };
  const stop = async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + STOP_AFTER_SEND_MS);
    await act(async () => host.querySelector<HTMLElement>('button[aria-label="Stop this turn"]')!.click());
    now.mockRestore();
  };
  const frame = (data: Record<string, unknown>) =>
    act(async () => FakeEventSource.last!.onmessage!({ data: JSON.stringify(data), lastEventId: "" }));
  return { box, host, posts, type, send, stop, frame, store: () => store };
}

describe("stop with queued sends", () => {
  it.each(["cancelled", "queued", "late queue", "returned", "landed"])("handles a posting send that Stop finds %s", async (outcome) => {
    const pasted = pasteAttachment("long log");
    const draftId = `bot:${bot.id}:${bot.threadId}`;
    setDraftAttachments(localStorage, draftId, [pasted]);
    let finish!: (receipt: Response) => void;
    const posting = new Promise<Response>((resolve) => { finish = resolve; });
    let sendId = "";
    const queued = { threadId: bot.threadId, queueId: "q1", get sendId() { return sendId; }, text: "first" };
    const ui = await mount({ bot: { ...bot, busy: false, activity: "idle" } }, (path, init) => {
      if (path.endsWith("/messages") && init?.method === "POST") {
        sendId = JSON.parse(String(init.body)).sendId;
        return posting;
      }
      if (init?.method === "DELETE" && path.includes("/queue/")) {
        if (path.endsWith("/q1")) return outcome === "late queue"
          ? Response.json({ cancelled: true, send: queued }) : Response.json({}, { status: 404 });
        return Response.json({ cancelled: outcome !== "landed", ...(outcome === "queued" ? { send: queued } : {}) });
      }
      if (path.endsWith("/interrupt")) return Response.json({ returned: outcome === "returned" ? [queued] : [] });
    });
    await ui.send("first");
    expect(sendId).toBeTruthy();
    expect(ui.box.value).toBe("");
    await ui.type("    still typing");
    await ui.stop();
    await act(async () => finish(Response.json({
      threadId: bot.threadId,
      ...(outcome === "cancelled" ? { cancelled: true }
        : outcome === "landed" ? { message: { id: "u1", role: "user", kind: "text", at: 1, text: "first", sendId } }
        : { queued: true, queueId: "q1" }),
    })));
    expect(ui.box.value).toBe(outcome === "landed" ? "    still typing" : "first\n\n    still typing");
    expect(getDraftAttachments(localStorage, draftId)).toEqual(outcome === "landed" ? [] : [pasted]);
  });

  it("hands queued 1:1 sends back to the composer in order, chips included", async () => {
    const pasted = pasteAttachment("long log");
    setDraftAttachments(localStorage, `bot:${bot.id}:${bot.threadId}`, [pasted]);
    const ui = await mount({ bot });
    await ui.send("first");
    await ui.send("second");
    await vi.waitFor(() => expect(ui.store().state.pendingQueued[bot.threadId]).toHaveLength(2), { timeout: 5000 });
    await ui.stop();
    await vi.waitFor(() => expect(ui.box.value).toBe("first\n\nsecond"), { timeout: 5000 });
    expect(ui.store().state.pendingQueued[bot.threadId]).toBeUndefined();
    expect(getDraftAttachments(localStorage, `bot:${bot.id}:${bot.threadId}`)).toEqual([pasted]);
    expect(ui.posts.filter((post) => post.path.endsWith("/messages"))).toHaveLength(2);
  });

  it("keeps the indentation of what is already typed", async () => {
    const ui = await mount({ bot });
    await ui.send("first");
    await vi.waitFor(() => expect(ui.store().state.pendingQueued[bot.threadId]).toHaveLength(1), { timeout: 5000 });
    await ui.type("    indented();\n");
    await ui.stop();
    await vi.waitFor(() => expect(ui.box.value).toBe("first\n\n    indented();\n"), { timeout: 5000 });
  });

  it("clears a queued row when another client's Stop hands it back", async () => {
    const ui = await mount({ bot });
    await ui.send("from phone");
    await vi.waitFor(() => expect(ui.store().state.pendingQueued[bot.threadId]).toHaveLength(1), { timeout: 5000 });
    await ui.frame({
      kind: "queue.cancelled",
      botId: bot.id,
      sends: [{ threadId: bot.threadId, queueId: "q-from phone", text: "from phone" }],
    });
    expect(ui.store().state.pendingQueued[bot.threadId]).toBeUndefined();
    expect(ui.box.value).toBe("");
    expect(ui.posts.map((post) => post.path)).toEqual([`/api/bots/${bot.id}/messages`]);
  });

  it("hands held room lines back instead of flushing them when the room settles", async () => {
    const ui = await mount({ group: room });
    await ui.send("held one", true);
    await ui.send("held two", true);
    expect(getRoomHolds(localStorage, `group:${room.id}:${room.threadId}`)).toHaveLength(2);
    await ui.stop();
    expect(ui.box.value).toBe("held one\n\nheld two");
    expect(getRoomHolds(localStorage, `group:${room.id}:${room.threadId}`)).toEqual([]);
    await act(async () => ui.store().dispatch({ type: "groupPatched", group: { ...room, working: false, busyBotId: null } }));
    expect(ui.posts.map((post) => post.path)).toEqual([`/api/groups/${room.id}/interrupt`]);
  });
});
