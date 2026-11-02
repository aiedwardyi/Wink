import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { _loadPending, bindPeerTurn, discardDelegations, discardDelegationsFrom, discardOrphanedDelegations, drainDelegations, drainWaitingOn, findDelegationReceipt, finishDelegatedTurn, queueDelegation, recordDelegationReceipt } from "./delegations.ts";
import { handMail, mailForTurn, settleMail } from "./mail.ts";
import { turnRegistry } from "./turn-registry.ts";
import { Store } from "./store.ts";

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  _loadPending();
});

const setup = () => {
  const store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  const from = store.createBot();
  const target = store.createBot();
  const wakeSender = vi.fn();
  const bus = { store, broadcast: () => {}, wakeSender };
  return { store, from, target, bus, wakeSender };
};

it("persists an accepted delegation before dispatch", () => {
  const { from, target, bus } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  expect(findDelegationReceipt(queued.id!)?.state).toBe("held");
  _loadPending();
  expect(findDelegationReceipt(queued.id!)?.source?.threadId).toBe(from.threadId);
});

it("keeps ready work through more than three busy settles", async () => {
  const { store, from, target, bus } = setup();
  store.setActivity(target.id, "working");
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  const run = vi.fn();
  drainDelegations(bus, bus, from.threadId, run);
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    drainWaitingOn(bus, bus, run);
  }
  await new Promise((resolve) => setImmediate(resolve));
  expect(findDelegationReceipt(queued.id!)?.state).toBe("ready");
  store.setActivity(target.id, "idle");
  drainWaitingOn(bus, bus, run);
  await new Promise((resolve) => setImmediate(resolve));
  expect(run).toHaveBeenCalledTimes(1);
});

it("schedules one wake for an idle sender's final delegation reply", async () => {
  const { from, target, bus, wakeSender } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  const run = vi.fn();
  drainDelegations(bus, bus, from.threadId, run);
  await new Promise((resolve) => setImmediate(resolve));
  const [, , , sourceThreadId, channel] = run.mock.calls[0];
  const turn = { toBotId: target.id, taskId: queued.id, sourceThreadId, sourceBotId: from.id, channelId: channel.id };
  finishDelegatedTurn(bus, turn, true, "The work is finished.");
  finishDelegatedTurn(bus, turn, true, "The work is finished.");
  expect(wakeSender).toHaveBeenCalledExactlyOnceWith(from.id, from.threadId);
});

it("keeps a busy sender's final reply for its next turn with zero wakes", async () => {
  const { store, from, target, bus, wakeSender } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  const run = vi.fn();
  drainDelegations(bus, bus, from.threadId, run);
  await new Promise((resolve) => setImmediate(resolve));
  store.setActivity(from.id, "working");
  finishDelegatedTurn(bus, { toBotId: target.id, taskId: queued.id, sourceThreadId: from.threadId, sourceBotId: from.id }, true, "Finished work");
  store.setActivity(from.id, "idle");
  expect(wakeSender).not.toHaveBeenCalled();
  expect(mailForTurn(store, from.threadId)[0].text).toContain("Finished work");
});

it("does not wake for an inline ask result", () => {
  const { from, target, bus, wakeSender } = setup();
  finishDelegatedTurn(bus, { taskId: "inline", toBotId: target.id, sourceThreadId: from.threadId, sourceBotId: from.id, ask: true, inline: true }, true, "inline answer");
  handMail(bus.store, from.threadId, "inline", "turn", "request");
  settleMail(bus.store, from.threadId, "turn", true);
  expect(wakeSender).not.toHaveBeenCalled();
  expect(mailForTurn(bus.store, from.threadId)).toEqual([]);
});

it("drops only the stopped turn's held work and preserves earlier ready work", () => {
  const { store, from, target, bus } = setup();
  store.setActivity(target.id, "working");
  turnRegistry.start("older", { botId: from.id, threadId: from.threadId, owner: "user", depth: 0 });
  const older = queueDelegation(bus, from, { toBotId: target.id, message: "older", depth: 0 }, 1);
  drainDelegations(bus, bus, from.threadId, () => {});
  turnRegistry.start("stopped", { botId: from.id, threadId: from.threadId, owner: "user", depth: 0 });
  const stopped = queueDelegation(bus, from, { toBotId: target.id, message: "stopped", depth: 0 }, 1);
  discardDelegations(bus, from.threadId, from.id, "stopped");
  expect(findDelegationReceipt(older.id!)?.state).toBe("ready");
  expect(findDelegationReceipt(stopped.id!)?.state).toBe("dropped");
  turnRegistry.settle("stopped");
});

it("keeps earlier ready work when a failed turn has no turn id", () => {
  const { store, from, target, bus } = setup();
  store.setActivity(target.id, "working");
  const ready = queueDelegation(bus, from, { toBotId: target.id, message: "ready", depth: 0 }, 1);
  drainDelegations(bus, bus, from.threadId, () => {});
  const held = queueDelegation(bus, from, { toBotId: target.id, message: "held", depth: 0 }, 1);
  discardDelegations(bus, from.threadId, from.id);
  expect(findDelegationReceipt(ready.id!)?.state).toBe("ready");
  expect(findDelegationReceipt(held.id!)?.state).toBe("dropped");
});

it("terminalizes running work on restart and repairs publication without waking", async () => {
  const { from, target, bus, wakeSender } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  drainDelegations(bus, bus, from.threadId, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  _loadPending();
  discardOrphanedDelegations(bus);
  expect(findDelegationReceipt(queued.id!)?.state).toBe("failed");
  expect(findDelegationReceipt(queued.id!)?.result).toBe("interrupted by a restart");
  expect(wakeSender).not.toHaveBeenCalled();
  const before = bus.store.messagesFor(from.threadId).length;
  discardOrphanedDelegations(bus);
  expect(bus.store.messagesFor(from.threadId)).toHaveLength(before);
});

it("releases a reply handed to a room turn after a restart", () => {
  const { store, from, target, bus } = setup();
  const room = store.createGroup("Room", [from.id, target.id]);
  const mailKey = `room-task:reply:${room.threadId}`;
  const row = store.appendMessage(room.threadId, { role: "bot", kind: "text", text: "Room reply", from: { botId: target.id, name: target.name, color: target.color }, comm: { groupId: room.id, withBotId: target.id, withName: target.name, withColor: target.color, peer: "reply", taskId: "room-task", mailKey, state: "done" } });
  handMail(store, room.threadId, "room-task", "crashed", "request");
  expect(mailForTurn(store, room.threadId)).toEqual([]);
  _loadPending();
  discardOrphanedDelegations(bus);
  expect(mailForTurn(store, room.threadId).map((part) => part.id)).toEqual([row.id]);
});

it("keeps a delegated reply when the receipt file cannot be written", async () => {
  const { store, from, target, bus } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  drainDelegations(bus, bus, from.threadId, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const file = join(DATA_DIR, "delegation-receipts.json");
  rmSync(file, { force: true });
  mkdirSync(file);
  expect(() => bindPeerTurn(target.threadId, "target-turn")).not.toThrow();
  expect(() => finishDelegatedTurn(bus, { toBotId: target.id, taskId: queued.id, sourceThreadId: from.threadId, sourceBotId: from.id }, true, "Finished work")).not.toThrow();
  expect(mailForTurn(store, from.threadId)[0].text).toContain("Finished work");
  expect(error).toHaveBeenCalledWith("delegations: could not persist receipts", expect.anything());
  error.mockRestore();
});

it("fails every open receipt targeting a deleted bot", () => {
  const { from, target, bus } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  discardDelegationsFrom(bus, target.id);
  expect(findDelegationReceipt(queued.id!)?.state).toBe("failed");
  expect(findDelegationReceipt(queued.id!)?.result).toBe(`error: delegation to ${target.id} failed — no such bot`);
});

it("retains an open receipt while pruning terminal receipts", () => {
  const { from, target, bus } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  for (let i = 0; i < 105; i++) recordDelegationReceipt({ id: `terminal-${i}`, sourceThreadId: from.threadId, toBotId: target.id, toBotName: target.name, status: "done" });
  _loadPending();
  expect(findDelegationReceipt(queued.id!)?.state).toBe("held");
});

it("repairs a question reply without arming a restart wake", () => {
  const { from, target, bus, wakeSender } = setup();
  const mailKey = `repair:reply:${from.threadId}`;
  recordDelegationReceipt({ id: "repair", sourceThreadId: from.threadId, toBotId: target.id, toBotName: target.name, source: { botId: from.id, threadId: from.threadId, turnId: "source" }, kind: "delegation", state: "finishing", status: "done", result: "Which branch?", publish: [{ threadId: from.threadId, mailKey, row: { role: "bot", kind: "activity", text: "Which branch?", origin: "local", comm: { groupId: "dm", withBotId: target.id, withName: target.name, withColor: target.color, peer: "reply", taskId: "repair", mailKey, wake: true, state: "done" } } }] });
  _loadPending();
  discardOrphanedDelegations(bus);
  discardOrphanedDelegations(bus);
  const rows = bus.store.messagesFor(from.threadId).filter((row) => row.comm?.mailKey === mailKey);
  expect(rows).toHaveLength(1);
  expect(rows[0].comm?.wake).toBeUndefined();
  expect(rows[0].origin).toBeUndefined();
  expect(wakeSender).not.toHaveBeenCalled();
  expect(mailForTurn(bus.store, from.threadId)[0].text).toContain("Which branch?");
});

it("publishes running work to a surviving channel after its sender is deleted", async () => {
  const { store, from, target, bus, wakeSender } = setup();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: "work", depth: 0 }, 1);
  const run = vi.fn();
  drainDelegations(bus, bus, from.threadId, run);
  await new Promise((resolve) => setImmediate(resolve));
  const channel = store.dmGroup(from.id, target.id)!;
  discardDelegationsFrom(bus, from.id);
  store.deleteBot(from.id);
  finishDelegatedTurn(bus, { taskId: queued.id, toBotId: target.id, sourceThreadId: from.threadId, sourceBotId: from.id }, true, "Completed work");
  expect(store.messagesFor(channel.threadId).filter((row) => row.text === "Completed work")).toHaveLength(1);
  expect(findDelegationReceipt(queued.id!)?.state).toBe("done");
  expect(wakeSender).not.toHaveBeenCalled();
});
