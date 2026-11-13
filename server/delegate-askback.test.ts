import { readFileSync, rmSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOrCreateChannel, type CommsBus } from "./comms-visibility.ts";
import { _resetCommsRoots, commit, reserve, ROOT_TURNS, rootForStart } from "./comms-root.ts";
import { DATA_DIR } from "./config.ts";
import { paneNotesForTurn, paneNotesSinceLastUserTurn, prepareModelContext, withoutTurnNotes } from "./context-compaction.ts";
import { _resetPending, acceptPeerTask, drainDelegations, finishDelegatedTurn, queueDelegation, type DelegatedTurn } from "./delegations.ts";
import { asksSender } from "./delegate-askback.ts";
import * as mail from "./mail.ts";
import { mailForTurn, markMailRead, markPaneMailRead } from "./mail.ts";
import { hasLocalUndeliveredPaneNote, isWakeNote, PANE_WAKE_DEBOUNCE_MS, PANE_WAKE_PROMPT, PaneWakeScheduler } from "./pane-wake.ts";
import * as paneWake from "./pane-wake.ts";
import { Store, type BotRecord } from "./store.ts";
import { buildTurnContext } from "./turn-context.ts";

describe("asksSender", () => {
  it.each([
    ["@Sender, which branch?", "Sender", true],
    ["@sEnDeR: ready?", "Sender", true],
    ["@Sender, all done.", "Sender", false],
    ["Which branch?", "Sender", false],
    ["@Sender `which?`", "Sender", false],
    ["@Sender ``literal `question?` ``", "Sender", false],
    ["@Sender\n```ts\nwhich?\n```", "Sender", false],
    ["@Sender\n~~~\nwhich?\n~~~", "Sender", false],
    ["@Sender\n\n    which?", "Sender", false],
    ["@Sender https://example.com/path?query=1", "Sender", false],
    ["@Sender https://example.com/path?", "Sender", false],
    ["@Sender https://example.com/_which?_", "Sender", false],
    ["@Sender <https://example.com/path?query=1>", "Sender", false],
    ["@Sender [link](https://example.com/path?query=1)", "Sender", false],
    ["@Sender www.example.com/path?query=1", "Sender", false],
    ["@Sender [Which branch?](https://example.com/path)", "Sender", true],
    ["@Sender https://example.com/path?query=1 Which branch?", "Sender", true],
    ["@포키 어떤 브랜치를 쓸까요?", "포키", true],
    ["@Sender-other, ready?", "Sender", false],
    ["@SenderTwo, ready?", "Sender", false],
    ["@Sender (one), ready?", "Sender (one)", true],
    ["`@Sender` Which branch?", "Sender", true],
    ["Ready?", "", false],
  ])("%s (%s) => %s", (reply, senderName, expected) => {
    expect(asksSender(reply, senderName)).toBe(expected);
  });
});

describe("delegated ask-back", () => {
  let store: Store;
  let sender: BotRecord;
  let peer: BotRecord;
  let bus: CommsBus & { wakeSender(botId: string, threadId: string): void };
  let turn: DelegatedTurn;
  let scheduler: PaneWakeScheduler;
  let busy: boolean;
  let root: string;
  const wake = vi.fn();
  const spend = (count = ROOT_TURNS) => {
    for (let index = 0; index < count; index++) {
      const credit = reserve(root, "delegation");
      if (credit.ok) commit(credit.reservation);
    }
  };

  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    wake.mockReset();
    busy = false;
    store = new Store(() => ({ instanceId: "claude", model: "fake-model" }));
    sender = store.patchBot(store.createBot().id, { name: "Sender" })!;
    peer = store.patchBot(store.createBot().id, { name: "Helper" })!;
    _resetCommsRoots();
    root = rootForStart(sender.threadId, { kind: "human", messageKey: "send-1" })!;
    bus = { store, deviceId: "local-device", broadcast: () => {}, wakeSender: (botId, threadId) => scheduler.noteArrived(botId, threadId) };
    const notes = (threadId: string) => paneNotesForTurn(store.activePath(threadId), new Set(), store.taskByThread(sender.id, threadId)?.paneNotesDeliveredId ?? undefined, false, false, 128_000);
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const enabled = source.match(/const paneWake = new PaneWakeScheduler\(\{\s+enabled: (.+),/)![1];
    const admit = source.match(/new PaneWakeScheduler\(\{[\s\S]+?\n  admit: (.+),\n/)![1];
    const pending = source.match(/\nfunction paneNotesPending\([\s\S]+?\n}\n/)![0];
    const javascript = ts.transpileModule(`${pending}\nconst enabled = ${enabled};\nconst admit = ${admit};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const scope = { ...paneWake, ...mail, paneNotesSinceLastUserTurn, store, commsBus: bus };
    const prod = new Function(...Object.keys(scope), `${javascript}\nreturn { enabled, admit, paneNotesPending };`)(...Object.values(scope));
    scheduler = new PaneWakeScheduler({
      enabled: prod.enabled,
      busy: () => busy,
      paused: (id) => store.bot(id)?.paneWakePaused === true,
      hasNotes: prod.paneNotesPending,
      wake: (botId, threadId, admission) => {
        if (admission.reservation) commit(admission.reservation);
        const pending = notes(threadId);
        const parts = mailForTurn(store, threadId, pending.ids, 128_000, pending.tokens);
        const input = buildTurnContext({
          text: [...pending.notes, ...parts.map((part) => part.text), PANE_WAKE_PROMPT].join("\n\n"),
          transcript: [], rewound: false, fresh: false, replaysNatively: false,
        });
        wake(botId, input.turnText);
        markMailRead(store, threadId, parts, "wake");
        markPaneMailRead(store, threadId, pending.ids ?? [], "wake", "fold");
        store.markPaneNotesDelivered(botId, threadId, pending.newestId);
      },
      admit: prod.admit,
      warn: () => {},
    });
    const queued = queueDelegation(bus, sender, { toBotId: peer.id, message: "Check this", depth: 0, root }, 1);
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
    });
    await vi.waitFor(() => expect(turn.taskId).toBe(queued.id));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    scheduler.forgetBot(sender.id);
    vi.useRealTimers();
    _resetPending();
  });

  it("wakes the sender once with the full delegated question and one reply row", async () => {
    const reply = "@Sender, which branch should I use?\n\nHere are the details.";
    finishDelegatedTurn(bus, turn, true, reply);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);

    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining(reply));
    expect(store.messagesFor(sender.threadId).filter((message) => message.text === reply)).toHaveLength(1);
    expect(store.messagesFor(sender.threadId).find((message) => message.text === reply)).toMatchObject({
      kind: "activity", tool: { name: "Reply from @Helper" }, comm: { peer: "reply", withBotId: peer.id, wake: true },
    });
    const channel = getOrCreateChannel(store, sender, peer);
    expect(store.messagesFor(channel.threadId).filter((message) => message.text === reply)).toHaveLength(1);
    finishDelegatedTurn(bus, turn, true, reply);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("waits for a busy sender to settle", async () => {
    busy = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("wakes once with terminal sharing disabled after the sender settles", async () => {
    store.patchBot(sender.id, { shareTerminalWithChat: false });
    busy = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    busy = false;
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, which branch?"));
    scheduler.noteArrived(sender.id, sender.threadId);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.messagesFor(sender.threadId).filter((message) => message.comm?.peer === "reply")).toHaveLength(1);
  });

  it("keeps ask-back wakes paused with terminal sharing disabled", async () => {
    store.patchBot(sender.id, { shareTerminalWithChat: false, paneWakePaused: true });
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    scheduler.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("keeps terminal notes disabled when terminal sharing is off", async () => {
    store.patchBot(sender.id, { shareTerminalWithChat: false });
    store.appendMessage(sender.threadId, { role: "bot", kind: "note", text: "Worker finished", origin: "local-device" });
    scheduler.noteArrived(sender.id, sender.threadId);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("preserves the root credit when posting the reply fails", async () => {
    spend(ROOT_TURNS - 1);
    const post = vi.spyOn(store, "appendMessage");
    for (let index = 0; index < 4; index++) {
      post.mockImplementationOnce((_threadId, message) => ({ ...message, id: "unsaved", at: Date.now() }));
      finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
      expect(wake).not.toHaveBeenCalled();
      queueDelegation(bus, sender, { toBotId: peer.id, message: "Try again", depth: 0, root }, 1);
      drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
        turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    finishDelegatedTurn(bus, turn, true, "@Sender, another question?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, another question?"));
  });

  it("reports an ask-back it could not wake the sender for", async () => {
    const replyUnwoken = vi.fn();
    bus.replyUnwoken = replyUnwoken;
    vi.spyOn(store, "appendMessage").mockImplementationOnce((_threadId, message) => ({ ...message, id: "unsaved", at: Date.now() }));
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    expect(replyUnwoken).toHaveBeenCalledExactlyOnceWith(sender.id, "reply post failed");
    queueDelegation(bus, sender, { toBotId: peer.id, message: "Try again", depth: 0, root }, 1);
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
    });
    await vi.advanceTimersByTimeAsync(0);
    spend();
    finishDelegatedTurn(bus, turn, true, "@Sender, which tag?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(replyUnwoken).toHaveBeenLastCalledWith(sender.id, "wake budget spent");
    expect(replyUnwoken).toHaveBeenCalledTimes(2);
    const paused = (threadId: string) => store.messagesFor(threadId).filter((row) => row.tool?.name?.startsWith("Bot messaging"));
    expect(paused(sender.threadId)).toHaveLength(1);
    expect(paused(getOrCreateChannel(store, sender, peer).threadId)).toHaveLength(1);
  });

  it.each([true, false])("delivers to the original task after the sender switches tasks (terminal sharing: %s)", async (shareTerminalWithChat) => {
    store.patchBot(sender.id, { shareTerminalWithChat });
    const sourceThreadId = sender.threadId;
    store.createTask(sender.id, "Other task");
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, which branch?"));
    expect(store.messagesFor(sourceThreadId).filter((message) => message.comm?.peer === "reply")).toHaveLength(1);
  });

  it.each([
    ["statement", "@Sender, finished."],
    ["unaddressed question", "Which branch?"],
    ["code question", "@Sender `which?`"],
  ])("wakes once for a %s reply without an ask-back note", async (_name, reply) => {
    finishDelegatedTurn(bus, turn, true, reply);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining(reply));
    expect(store.messagesFor(sender.threadId).some(isWakeNote)).toBe(false);
  });

  it("does not wake for a failed delegation", async () => {
    finishDelegatedTurn(bus, turn, false, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(store.messagesFor(sender.threadId).some(isWakeNote)).toBe(false);
  });

  it("does not wake after the sender is deleted", async () => {
    store.deleteBot(sender.id);
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes once for the peer question after a short user reply", async () => {
    finishDelegatedTurn(bus, turn, true, "<user1>Got it.</user1>@Sender, which branch?");
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.messagesFor(sender.threadId).filter((message) => message.comm?.peer === "reply")).toHaveLength(1);
  });

  it.each([false, true])("does not wake for a room reply (ask: %s)", async (ask) => {
    const room = store.createGroup("Room", [sender.id, peer.id]);
    turn.sourceThreadId = room.threadId;
    if (ask) turn.ask = true;
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).not.toHaveBeenCalled();
    expect(store.messagesFor(room.threadId).some(isWakeNote)).toBe(false);
  });

  it("wakes once for an adopted private ask_bot reply without an ask-back note", async () => {
    const taskId = acceptPeerTask(sender, peer, sender.threadId, "ask", "dispatching", undefined, root);
    turn = { toBotId: peer.id, sourceThreadId: sender.threadId, channelId: getOrCreateChannel(store, sender, peer).id, taskId, sourceBotId: sender.id, ask: true };
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("@Sender, which branch?"));
    expect(store.messagesFor(sender.threadId).some(isWakeNote)).toBe(false);
  });

  it("wakes for a pane note after the reply wake budget is spent", async () => {
    const replyUnwoken = vi.fn();
    bus.replyUnwoken = replyUnwoken;
    spend();
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    store.appendMessage(sender.threadId, { role: "bot", kind: "note", text: "Worker finished", origin: "local-device" });
    scheduler.noteArrived(sender.id, sender.threadId);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith(sender.id, expect.stringContaining("Worker finished"));
    expect(replyUnwoken).not.toHaveBeenCalled();
  });

  it("re-arms only local, undelivered ask-back rows after restart", () => {
    finishDelegatedTurn(bus, turn, true, "@Sender, which branch?");
    const messages = new Store(() => ({ instanceId: "claude", model: "fake-model" })).activePath(sender.threadId);
    const reply = messages.findLast(isWakeNote)!;
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "local-device")).toBe(true);
    expect(hasLocalUndeliveredPaneNote(messages, reply.id, "local-device")).toBe(false);
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "local-device", reply.id)).toBe(false);
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "other-device")).toBe(false);
    expect(paneNotesSinceLastUserTurn(messages, new Set(), reply.id)).toEqual([]);
    expect(paneNotesSinceLastUserTurn(messages, new Set([reply.id]))).toEqual([]);
  });

  it.each([
    ["resumed", false, false],
    ["inline replay", true, false],
    ["native replay", true, true],
  ])("carries the full activity reply exactly once in %s turn input", async (_name, fresh, replaysNatively) => {
    const reply = "@Sender, which branch should I use?\n\nKeep the full reply, including `code` and https://example.com/?detail=1.";
    finishDelegatedTurn(bus, turn, true, reply);
    const messages = store.activePath(sender.threadId);
    const prepared = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "" });
    if (prepared.status !== "ready") throw new Error("context not ready");
    const pending = paneNotesForTurn(messages, new Set(), undefined, fresh, !replaysNatively, 200_000);
    const parts = mailForTurn(store, sender.threadId, pending.ids, 200_000, pending.tokens);
    const transcript = withoutTurnNotes(prepared.transcript, pending.notes);
    const input = buildTurnContext({
      text: [...pending.notes, ...parts.map((part) => part.text), PANE_WAKE_PROMPT].join("\n\n"),
      transcript, rewound: false, fresh, replaysNatively,
    });
    const delivered = [input.turnText, ...(replaysNatively ? transcript.map((message) => message.text) : [])].join("\n\n");
    expect(delivered.split(reply)).toHaveLength(2);
    expect(pending.newestId).toBe(messages.findLast(isWakeNote)!.id);
    expect(messages.filter((message) => message.kind === "note")).toHaveLength(0);
  });

  it("bounds ping-pong by the root budget while preserving the depth cap", async () => {
    const ids = new Set([turn.taskId]);
    // the first delegation's start and one other start, then a reply wake and a follow-up start per round
    spend(2);
    const rounds = (ROOT_TURNS - 2) / 2;
    for (let index = 0; index <= rounds; index++) {
      finishDelegatedTurn(bus, turn, true, `@Sender, question ${index}?`);
      await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
      if (index === rounds) break;
      expect(wake).toHaveBeenCalledTimes(index + 1);
      expect(queueDelegation(bus, peer, { toBotId: sender.id, message: "Recurse", depth: 1, root }, 1).result).toBe("too_deep");
      const queued = queueDelegation(bus, sender, { toBotId: peer.id, message: "Follow up", depth: 0, root }, 1);
      expect(queued.result).toBe("ok");
      expect(ids.has(queued.id)).toBe(false);
      ids.add(queued.id);
      spend(1);
      drainDelegations(bus, bus, sender.threadId, (toBotId, _text, depth, sourceThreadId, channel, taskId, sourceBotId) => {
        expect(depth).toBe(1);
        turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(wake).toHaveBeenCalledTimes(rounds);
    expect(reserve(root, "wake")).toEqual({ ok: false, reason: "exhausted" });
    root = rootForStart(sender.threadId, { kind: "human", messageKey: "send-2" })!;
    queueDelegation(bus, sender, { toBotId: peer.id, message: "User's next request", depth: 0, root }, 1);
    drainDelegations(bus, bus, sender.threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
      turn = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
    });
    await vi.advanceTimersByTimeAsync(0);
    finishDelegatedTurn(bus, turn, true, "@Sender, another question?");
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(wake).toHaveBeenCalledTimes(rounds + 1);
  });
});
