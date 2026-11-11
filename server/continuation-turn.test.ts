// Continuation turns: an idle bot adopts one like a user-sent turn, and a
// send that arrives meanwhile waits in the queue until it settles.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "./config.ts";
import { foldContinuationStart, joinRunningTurn, type ContinuationDeps } from "./continuation-turn.ts";
import type { ProviderAdapter, ProviderInstance } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { drainSteeredMessages, queueSteeredMessage, _queuedCount, _resetSteerQueue, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");

function fakeBot(busy = false): BotRecord {
  return {
    id: "bot-a",
    threadId: "thread-a",
    name: "bot-a",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "fake", model: "fake-model" },
    resumeCursors: {},
    busy,
    createdAt: 0,
  };
}

function rig(bot: BotRecord, claimed = false) {
  const watchdog = new TurnWatchdog({ stallMs: 10_000, toolCapMs: 30_000, checkMs: 60_000, onStall: () => {} });
  const disowned: string[] = [];
  const deps: ContinuationDeps = {
    botByThread: (threadId) => (threadId === bot.threadId ? bot : null),
    claimed: () => claimed,
    adopt: (botId, threadId) => {
      bot.busy = true;
      bot.activeThreadId = threadId;
      watchdog.watch(threadId, botId);
    },
    disown: (turnId) => disowned.push(turnId),
  };
  return { watchdog, disowned, deps };
}

describe("foldContinuationStart", () => {
  afterEach(() => _resetSteerQueue());

  it("marks an idle bot busy and watches the thread", () => {
    const bot = fakeBot();
    const { watchdog, deps } = rig(bot);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, deps)).toBe("adopted");
    expect(bot.busy).toBe(true);
    expect(bot.activeThreadId).toBe("thread-a");
    expect(watchdog.watching("thread-a")).toBe(true);
  });

  it("leaves a turn the harness dispatched alone", () => {
    const bot = { ...fakeBot(true), activeThreadId: "thread-a" };
    const { watchdog, disowned, deps } = rig(bot);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-1" }, deps)).toBe("owned");
    expect(watchdog.watching("thread-a")).toBe(false);
    expect(disowned).toEqual([]);
  });

  it("disowns a continuation while the bot works another thread or holds a claim", () => {
    const busyElsewhere = { ...fakeBot(true), activeThreadId: "thread-b" };
    const first = rig(busyElsewhere);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, first.deps)).toBe("disowned");
    expect(first.disowned).toEqual(["turn-late"]);
    expect(busyElsewhere.activeThreadId).toBe("thread-b");

    const second = rig(fakeBot(), true);
    expect(foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, second.deps)).toBe("disowned");
  });

  it("ignores room and unknown threads", () => {
    const { deps } = rig(fakeBot());
    expect(foldContinuationStart({ threadId: "room-1", turnId: "turn-late" }, deps)).toBe("ignored");
  });

  it("holds a user send until the continuation settles", () => {
    const bot = fakeBot();
    const { deps } = rig(bot);
    const messages: Message[] = [];
    const store: SteerStore = {
      bot: (id) => (id === bot.id ? bot : null),
      messagesFor: () => messages,
      appendMessage: (threadId, message) => {
        const full: Message = { id: `m${messages.length + 1}-${threadId}`, at: 0, ...message };
        messages.push(full);
        return full;
      },
      patchMessage: () => null,
    };
    foldContinuationStart({ threadId: "thread-a", turnId: "turn-late" }, deps);
    queueSteeredMessage(bot.id, bot.threadId, "next step");
    const run = vi.fn();

    drainSteeredMessages(store, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedCount("thread-a")).toBe(1);

    // turn.completed folds the bot idle before the drain subscriber runs
    bot.busy = false;
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(messages[0]).toMatchObject({ role: "user", text: "next step" });
  });
});

describe("joinRunningTurn", () => {
  const turn = { threadId: "thread-a", text: "A pane note arrived. Act on it.", resumeCursor: "session-1", systemUpdate: "" };

  function engine(holds: boolean, written = true) {
    const steered: string[] = [];
    const adapter = {
      capabilities: { queueing: true } as ProviderAdapter["capabilities"],
      hasSession: () => holds,
      steer: async (_threadId: string, text: string) => {
        steered.push(text);
        return written;
      },
    };
    return { adapter, steered };
  }

  it("leaves an idle thread, a fresh session and a system update to sendTurn", async () => {
    const idle = engine(false);
    await expect(joinRunningTurn(idle.adapter, turn, "turn-done")).resolves.toBeNull();
    const held = engine(true);
    await expect(joinRunningTurn(held.adapter, { ...turn, resumeCursor: undefined }, "turn-late")).resolves.toBeNull();
    await expect(joinRunningTurn(held.adapter, { ...turn, systemUpdate: "changed" }, "turn-late")).resolves.toBeNull();
    expect([...idle.steered, ...held.steered]).toEqual([]);
  });

  it("sends as usual when the running turn ended before the steer landed", async () => {
    await expect(joinRunningTurn(engine(true, false).adapter, turn, "turn-late")).resolves.toBeNull();
  });

  describe("on the Claude driver (fake CLI)", () => {
    let instance: ProviderInstance | undefined;
    let recorder: EventRecorder | undefined;

    afterEach(async () => {
      recorder?.stop();
      await instance?.dispose();
      instance = undefined;
    });

    it("steers a dispatch into the turn the CLI woke into after the busy gate", async () => {
      ensureDirs();
      chmodSync(FAKE_CLI, 0o755);
      instance = await ClaudeDriver.create({
        instanceId: "claude-join",
        displayName: "Claude",
        enabled: true,
        environment: { FAKE_CLAUDE_MODE: "late-wake" },
        config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
      });
      const { adapter } = instance;
      const events = (recorder = recordEvents(adapter));
      const first = await adapter.sendTurn({ threadId: "t-join", text: "one" });
      await events.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
      const woke = await events.until((e) => e.type === "turn.started" && e.turnId !== first.turnId);
      const opened = await events.until((e) => e.type === "request.opened" && e.turnId === woke.turnId);

      const wake = { ...turn, threadId: "t-join" };
      await expect(adapter.sendTurn(wake)).rejects.toThrow("a turn is already running on this thread");
      await expect(joinRunningTurn(adapter, wake, woke.turnId)).resolves.toEqual({ turnId: woke.turnId });

      await adapter.respondToRequest("t-join", (opened as { requestId: string }).requestId, { behavior: "allow" });
      await events.until((e) => e.type === "turn.completed" && e.turnId === woke.turnId);
      expect(events.events).toContainEqual(expect.objectContaining({
        type: "item.completed",
        itemType: "assistant_text",
        text: `background allow + steered: ${turn.text}`,
        turnId: woke.turnId,
      }));
      expect(events.events.filter((e) => e.type === "turn.started")).toHaveLength(2);
    });
  });
});
