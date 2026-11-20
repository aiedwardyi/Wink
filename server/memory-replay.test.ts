import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { createMemoryPass, type NoteGenerator } from "./memory-pass.ts";
import type { Message, StoreChange } from "./store.ts";
import { asksNudge, type AskBook, type SavedAsks } from "./task-asks.ts";
import { readTaskResumePacket, writeTaskResumePacket } from "./task-state.ts";
import { taskRecordBlock } from "./turn-context.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { LAPTOP_FOLLOW_UP, MISSES, type Miss, type MissRow } from "./testing/memory-misses.ts";
import { writeMemoryFile } from "./workspace.ts";

const temps = createTempDirs();
const scores: string[] = [];
afterAll(() => {
  console.log(["| miss | saved | read back | obeyed | junk filed |", "|---|---|---|---|---|", ...scores].join("\n"));
  temps.remove();
});

// files every bot line it is shown, so only the scan keeps junk out; a model-guarded miss gets the careful answer the real run checks
const eager = (careful: boolean): NoteGenerator => async (prompt) => {
  const lines = /<bot_lines>\n([\s\S]*?)\n<\/bot_lines>/.exec(prompt)?.[1]?.split("\n").map((line) => line.replace(/^- /, "")) ?? [];
  const open = [...(/<promises>\n([\s\S]*?)\n<\/promises>/.exec(prompt)?.[1] ?? "").matchAll(/^(A\d+): (.*)$/gm)];
  return JSON.stringify(lines.flatMap((line) => {
    if (open.length && /\bchecked\b/i.test(line)) return [{ kind: "done", fact: open[0]![1], quote: line }];
    // files a repeat in the repeat's own words, as the real note-taker did on 11-20
    if (open.length) return [{ kind: "promise", fact: line, quote: line }];
    if (careful) return [];
    return [{ kind: "promise", fact: line.slice(0, 80), quote: line }];
  }));
};

function replay(name: string) {
  const dir = temps.make(join(tmpdir(), "memory-replay-"));
  const threadId = `${name}-thread`;
  const botId = `${name}-bot`;
  const rows: Message[] = [];
  const listeners = new Set<(change: StoreChange) => void>();
  let seq = 0;
  const store = {
    onChange: (listener: (change: StoreChange) => void) => (listeners.add(listener), () => listeners.delete(listener)),
    messagesFor: () => rows,
    groupByThread: () => undefined,
    // SAFETY: the pass only reads the bot id.
    botByThread: () => ({ id: botId }) as never,
    appendMessage(_thread: string, message: Omit<Message, "id" | "at">) {
      const full: Message = { id: `m${++seq}`, at: Date.now(), ...message };
      rows.push(full);
      for (const listener of listeners) listener({ type: "message", threadId, message: full });
      return full;
    },
  };
  const now = Date.now();
  writeMemoryFile(botId, "");
  writeTaskResumePacket({
    v: 1, threadId, botId, goal: "Help the user", plan: [], completed: [], evidence: [], artifacts: [], blockers: [], nextAction: "",
    updatedAt: now, updatedBy: "harness", flushReason: "turn-end", turnsAtWrite: 0,
  }, { dir });
  let model = eager(false);
  const pass = createMemoryPass({
    store, dataDir: dir, generate: () => (prompt, signal) => model(prompt, signal), enabled: () => true, busy: () => false,
    asks: (thread) => readTaskResumePacket(thread, { dir }),
    saveAsks: (thread, change: (book: AskBook | undefined) => SavedAsks | null) => {
      const current = readTaskResumePacket(thread, { dir });
      const saved = current && change(current);
      if (current && saved) writeTaskResumePacket({ ...current, ...saved, updatedAt: Date.now(), updatedBy: "harness" }, { dir });
    },
  });
  return {
    async chat(said: MissRow[], careful = false) {
      model = eager(careful);
      for (const row of said) {
        store.appendMessage(threadId, { role: row.role, kind: "text", text: row.text });
        if (row.tool) store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: row.tool, ok: true } });
      }
      pass.onSettled(botId, threadId, true);
      await pass.idle();
    },
    // read from disk, as a restarted server does
    asks: () => readTaskResumePacket(threadId, { dir })?.asks ?? [],
    record: () => readTaskResumePacket(threadId, { dir })!,
    dispose: () => pass.dispose(),
  };
}

describe("memory replay: the bot's own promises", () => {
  it.each(MISSES)("$day $id", async (miss: Miss) => {
    const run = replay(miss.id);
    await run.chat(miss.rows, miss.guard === "model");
    const promises = run.asks().filter((ask) => ask.kind === "promise");
    const saved = miss.promise ? promises.find((ask) => ask.ask === miss.promise!.slice(0, 80)) : undefined;
    const junk = promises.filter((ask) => ask !== saved).length;
    const restart = taskRecordBlock(run.record(), 6_000, { recovering: true, latestUserText: miss.probe ?? "" });
    const readBack = saved ? restart.includes(saved.ask) && asksNudge(run.asks(), Date.now(), "what's left for today?").includes(saved.ask) : false;
    scores.push(`| ${miss.day} ${miss.id} | ${miss.promise ? (saved ? "yes" : "NO") : "-"} | ${miss.promise ? (readBack ? "yes" : "NO") : "-"} | ${miss.probe ? "real-model run" : "-"} | ${junk} |`);
    run.dispose();
    expect(junk).toBe(0);
    if (!miss.promise) return;
    expect(saved, "promise never saved").toBeDefined();
    expect(readBack, "promise not read back after a restart").toBe(true);
    // an ordinary turn pays nothing for it
    if (miss.probe) expect(asksNudge(run.asks(), Date.now(), miss.probe)).toBe("");
  });

  it("merges a repeated promise and closes it once the bot reports it done", async () => {
    const [laptop] = MISSES;
    const run = replay("laptop-follow-up");
    await run.chat(laptop!.rows);
    const filed = run.asks().find((ask) => ask.kind === "promise")!;
    expect(filed).toMatchObject({ status: "open", ask: laptop!.promise });
    await run.chat(LAPTOP_FOLLOW_UP.repeat, true);
    expect(run.asks().filter((ask) => ask.kind === "promise")).toEqual([filed]);
    await run.chat(LAPTOP_FOLLOW_UP.report, true);
    expect(run.asks().filter((ask) => ask.kind === "promise")).toEqual([expect.objectContaining({ id: filed.id, status: "done" })]);
    run.dispose();
  });
});
