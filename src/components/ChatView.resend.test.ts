// @vitest-environment happy-dom
import { rmSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";

import { DATA_DIR } from "../../server/config.ts";
import { _resetCommsRoots, rootForStart } from "../../server/comms-root.ts";
import type { CommsBus } from "../../server/comms-visibility.ts";
import {
  drainDelegations,
  finishDelegatedTurn,
  queueDelegation,
  _pendingCount,
  _resetPending,
  type DelegatedTurn,
} from "../../server/delegations.ts";
import { watchPeerTurn } from "../../server/peer-takeover.ts";
import { _resetPeerUserReplies, beginPeerUserReply, persistPeerUserReply } from "../../server/peer-user-reply.ts";
import { Store, type BotRecord, type GroupRecord } from "../../server/store.ts";

import { ChatView } from "./ChatView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const toBot = (record: BotRecord, messages: Message[]): Bot => ({
  id: record.id, threadId: record.threadId, name: record.name, title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: false, activity: "idle", modelSelection: { instanceId: "inst", model: "m" }, messages,
});

async function mount(current: Bot) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null,
    createElement(StoreProvider, null, createElement(ChatView, { bot: current })),
  )));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

describe("a user's reply during a peer turn", () => {
  let store: Store;
  let career: BotRecord;
  let wink: BotRecord;
  let commsBus: CommsBus;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    _resetPeerUserReplies();
    store = new Store(() => ({ instanceId: "claude", model: "fake-model" }));
    career = store.patchBot(store.createBot().id, { name: "Career" })!;
    wink = store.patchBot(store.createBot().id, { name: "Wink" })!;
    commsBus = { store, broadcast: () => {} };
    _resetCommsRoots();
  });

  const runTarget = (_to: string, _prompt: string, _depth: number, _src: string, channel: GroupRecord | undefined, taskId: string, _from: string, transcriptText?: string) => {
    // the user row startTurn stores for a peer's message
    store.appendMessage(wink.threadId, {
      role: "user",
      kind: "text",
      text: transcriptText,
      from: { botId: career.id, name: career.name, color: career.color },
      comm: channel ? { groupId: channel.id, withBotId: career.id, withName: career.name, withColor: career.color } : undefined,
    });
    turn = { channelId: channel?.id, toBotId: wink.id, taskId, sourceThreadId: career.threadId, sourceBotId: career.id };
  };
  let turn: DelegatedTurn;
  const drain = () => drainDelegations(commsBus, { store, broadcast: () => {} }, career.threadId, runTarget);

  it.each([
    [1280, "Arial"], [360, "Arial"], [392, "Arial"], [392, "Verdana"],
  ])("keeps peer attribution and the user's short reply separate at %s px with %s", async (width, font) => {
    vi.stubGlobal("innerWidth", width);
    document.body.style.fontFamily = String(font);
    const root = rootForStart(career.threadId, { kind: "human", messageKey: "send-1" })!;
    queueDelegation(commsBus, career, { toBotId: wink.id, message: "What changed in the resume?", depth: 0, root }, 1);
    drain();
    await vi.waitFor(() => expect(turn && _pendingCount(career.threadId)).toBe(0));
    const end = watchPeerTurn(wink.threadId);
    const input = beginPeerUserReply(wink.id, wink.threadId, "Hey Wink")!;
    input.accept(store.appendMessage(wink.threadId, { role: "user", kind: "text", text: "Hey Wink", steered: true }));
    const tag = input.prompt.match(/<user\d+>/)![0];
    const text = `${tag}네, 확인할게요.${tag.replace("<", "</")}\nTwo bullets were reworded.`;
    persistPeerUserReply(store, {
      provider: "claude", eventId: "reply", createdAt: new Date().toISOString(), threadId: wink.threadId,
      type: "item.completed", itemType: "assistant_text", text,
    });
    end();
    finishDelegatedTurn(commsBus, turn, true, text);
    drain();
    await vi.waitFor(() => expect(store.messagesFor(wink.threadId).filter((m) => m.role === "user" && m.from)).toHaveLength(1));

    const stored = store.messagesFor(wink.threadId);
    const rows = stored.filter((m) => m.tool?.name === "Message from @Career" || (m.role === "user" && m.from));
    expect(rows.map((m) => m.tool?.name ?? m.text)).toEqual([
      "Message from @Career", "What changed in the resume?",
    ]);

    const host = await mount(toBot(wink, stored as Message[]));
    expect(host.textContent?.match(/네, 확인할게요\./g)).toHaveLength(1);
    expect(host.textContent).not.toContain("Two bullets were reworded.");
    expect(host.textContent).not.toContain("<user");
    const speaker = (text: string) => [...host.querySelectorAll("[data-mid]")]
      .find((row) => row.textContent?.includes(text))?.querySelector(".orbit-message-speaker")?.textContent;
    expect(["What changed in the resume?", "Hey Wink"].map(speaker)).toEqual(["Career", "You"]);
    expect(store.messagesFor(career.threadId).filter((message) => message.comm?.peer === "reply").map((message) => message.text)).toEqual(["Two bullets were reworded."]);
    document.body.style.fontFamily = "";
  });
});
