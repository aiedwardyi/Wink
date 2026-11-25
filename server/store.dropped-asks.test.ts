import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import { Store } from "./store.ts";
import { isOpenAsk, type TaskAsk } from "./task-asks.ts";
import { readTaskResumePacket, TASK_STATE_MAX_BYTES, type TaskResumePacket } from "./task-state.ts";
import { removeTestData } from "./testing/test-home.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

const taskPacket = (botId: string, threadId: string, overrides: Partial<TaskResumePacket> = {}): TaskResumePacket => ({
  v: 1,
  threadId,
  botId,
  goal: "Prepare the weekly report",
  plan: [{ step: "Write the draft", status: "active" }],
  completed: [],
  evidence: [],
  artifacts: [],
  blockers: [],
  nextAction: "Write the draft",
  updatedAt: 100,
  updatedBy: "harness",
  flushReason: "progress",
  turnsAtWrite: 0,
  ...overrides,
});
const ask = (id: number, overrides: Partial<TaskAsk> = {}): TaskAsk => ({ id: `A${id}`, ask: `Ship part ${id} of the release notes`, status: "open", at: 100, changedAt: 100, ...overrides });
const budgeted = (packet: TaskResumePacket) => Buffer.byteLength(JSON.stringify({ ...packet, asks: packet.asks?.filter((item) => !isOpenAsk(item)) }, null, 2), "utf8");

function nearBudget(botId: string, threadId: string, asks: TaskAsk[], headroom: number): TaskResumePacket {
  const filled = taskPacket(botId, threadId, {
    completed: Array.from({ length: 30 }, (_, index) => ({ note: `Step ${index} ${"done ".repeat(57)}`.trim(), at: 100 + index })),
    evidence: Array.from({ length: 15 }, (_, index) => ({ kind: "url" as const, ref: `https://example.com/${index}/${"x".repeat(300)}` })),
    asks,
    lastAskId: asks.length,
    goal: "",
  });
  return { ...filled, goal: "g".repeat(TASK_STATE_MAX_BYTES - headroom - budgeted(filled)) };
}

const dropLog = (threadId: string) => {
  const file = join(DATA_DIR, "task-state-dropped", `${threadId}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

describe("Store drop log", () => {
  beforeEach(() => {
    removeTestData(DATA_DIR);
  });

  it("logs the ask a close drops from a packet 105 B under budget", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const saved = store.writeTaskPacket(nearBudget(bot.id, bot.threadId, [ask(1), ask(2)], 105))!;
    expect(budgeted(saved)).toBe(TASK_STATE_MAX_BYTES - 105);
    const closed = ask(1, { status: "done", changedAt: 200 });

    const after = store.writeTaskPacket({ ...saved, asks: [closed, ask(2)] });

    expect(after?.asks).toEqual([ask(2)]);
    expect(dropLog(bot.threadId)).toEqual([{ at: expect.any(Number), botId: bot.id, threadId: bot.threadId, ask: closed }]);
  });

  it("logs the ask an owner repair drops", () => {
    const store = new Store(selection);
    const owner = store.createBot();
    const replacement = store.createBot();
    const room = store.createGroup("Release", [owner.id, replacement.id]);
    const closed = ask(1, { status: "done", changedAt: 200 });
    // an older build saved closed asks past today's budget, so the repair's write is the first to bound them
    mkdirSync(join(DATA_DIR, "task-state"), { recursive: true });
    writeFileSync(join(DATA_DIR, "task-state", `${room.threadId}.json`), JSON.stringify({ ...nearBudget(owner.id, room.threadId, [ask(2)], 100), asks: [closed, ask(2)], lastAskId: 2 }, null, 2));

    new Store(selection).patchGroup(room.id, { memberIds: [replacement.id] });

    expect(readTaskResumePacket(room.threadId)).toMatchObject({ botId: replacement.id, asks: [ask(2)] });
    expect(dropLog(room.threadId)).toEqual([{ at: expect.any(Number), botId: replacement.id, threadId: room.threadId, ask: closed }]);
  });

  it("writes every task packet through savePacket", () => {
    const server = dirname(fileURLToPath(import.meta.url));
    const writers = readdirSync(server, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "task-state.ts")
      .filter((file) => {
        const source = readFileSync(join(server, file), "utf8").replace(/\r\n/g, "\n");
        return /\b(write|stage)TaskResumePacket\(/.test(file === "store.ts" ? source.replace(/\n {2}private savePacket\([\s\S]*?\n {2}\}\n/, "\n") : source);
      })
      .map((file) => file.replaceAll("\\", "/"));
    expect(writers, "save task packets with Store.writeTaskPacket, never writeTaskResumePacket or stageTaskResumePacket: its savePacket logs every ask a write drops").toEqual([]);
  });

  it("redacts secrets in dropped asks the input and seen hold", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const closed = ask(1, { ask: `Rotate the leaked key ${KEY}`, status: "done", changedAt: 200 });
    const queued = ask(3, { ask: "Call the bank back", ref: `card token ${KEY}` });

    store.writeTaskPacket({ ...nearBudget(bot.id, bot.threadId, [ask(2)], 100), asks: [closed, ask(2)], lastAskId: 3 }, {}, [queued]);

    const lines = dropLog(bot.threadId);
    expect(lines.map((line) => line.ask)).toEqual([
      { ...queued, ref: redactSecretsInText(queued.ref!) },
      { ...closed, ask: redactSecretsInText(closed.ask) },
    ]);
    expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it("saves the packet and reports it when the drop log cannot be written", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.writeTaskPacket(taskPacket(bot.id, bot.threadId, { asks: [ask(1), ask(2)], lastAskId: 2 }));
    writeFileSync(join(DATA_DIR, "task-state-dropped"), "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const saved = store.writeTaskPacket(taskPacket(bot.id, bot.threadId, { asks: [ask(2)], lastAskId: 2 }));

    expect(saved?.asks).toEqual([ask(2)]);
    expect(readTaskResumePacket(bot.threadId)).toEqual(saved);
    expect(store.taskPacket(bot.threadId)).toEqual(saved);
    expect(error).toHaveBeenCalledWith("task state: drop log failed", expect.any(Error));
    error.mockRestore();
  });

  it("reads the saved packet on a cache miss, so an ask only the disk held is logged", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.writeTaskPacket(taskPacket(bot.id, bot.threadId, { asks: [ask(1), ask(2)], lastAskId: 2 }));

    new Store(selection).writeTaskPacket(taskPacket(bot.id, bot.threadId, { asks: [ask(2)], lastAskId: 2 }));

    expect(dropLog(bot.threadId)).toEqual([{ at: expect.any(Number), botId: bot.id, threadId: bot.threadId, ask: ask(1) }]);
  });

  it("hands the asks of a queued record a later one replaced to the store as seen", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const body = (name: string) => index.slice(index.indexOf(`function ${name}(`), index.indexOf("\n}\n", index.indexOf(`function ${name}(`)));
    expect(body("queueTaskPacket")).toContain("pending.seen = [...(pending.seen ?? []), ...(pending.packet.asks ?? [])];");
    expect(body("persistTaskPacket")).toContain("store.writeTaskPacket(packet, opts, [...(pending?.seen ?? []), ...(pending?.packet.asks ?? [])])");
  });
});
