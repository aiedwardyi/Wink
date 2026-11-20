import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { createMemoryPass, type NoteGenerator } from "./memory-pass.ts";
import type { Message, StoreChange } from "./store.ts";
import { asksNudge, mergeTaskAsks, type AskBook, type SavedAsks } from "./task-asks.ts";
import { readTaskResumePacket, writeTaskResumePacket, type TaskResumePacket } from "./task-state.ts";
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

const botLinesIn = (prompt: string) => /<bot_lines>\n([\s\S]*?)\n<\/bot_lines>/.exec(prompt)?.[1]?.split("\n").map((line) => line.replace(/^- /, "")) ?? [];
const promised = (lines: string[]) => JSON.stringify(lines.filter((line) => line.includes("I'll")).map((line) => ({ kind: "promise", fact: line, quote: line })));
// the gate's note-taker: every "I'll" line it is shown is a promise
const filesEvery: NoteGenerator = async (prompt) => promised(botLinesIn(prompt));
// skips a promise when the same lines report the work done, as the prompt asks
const skipsDone: NoteGenerator = async (prompt) => botLinesIn(prompt).some((line) => !line.includes("I'll")) ? "[]" : promised(botLinesIn(prompt));

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
  const prompts: string[] = [];
  const pass = createMemoryPass({
    store, dataDir: dir, generate: () => (prompt, signal) => (prompts.push(prompt), model(prompt, signal)), enabled: () => true, busy: () => false,
    asks: (thread) => readTaskResumePacket(thread, { dir }),
    saveAsks: (thread, change: (book: AskBook | undefined) => SavedAsks | null) => {
      const current = readTaskResumePacket(thread, { dir });
      const saved = current && change(current);
      if (current && saved) writeTaskResumePacket({ ...current, ...saved, updatedAt: Date.now(), updatedBy: "harness" }, { dir });
    },
  });
  return {
    chat(said: MissRow[], careful = false) {
      return this.talk(said, eager(careful));
    },
    async talk(said: MissRow[], helper: NoteGenerator) {
      model = helper;
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
    write: (record: TaskResumePacket) => writeTaskResumePacket(record, { dir }),
    say: (row: MissRow) => store.appendMessage(threadId, { role: row.role, kind: "text", text: row.text }),
    prompts,
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

const LAPTOP = "I'll check the laptop backup tomorrow.";
const ask = { role: "user", text: "Please follow up." } as const;

describe("memory replay: gate 2073 cases", () => {
  it("never closes a promise retitled while the note-taker read the report", async () => {
    const run = replay("stale-done");
    await run.talk([ask, { role: "bot", text: LAPTOP }], filesEvery);
    let reading!: () => void;
    let release!: () => void;
    const read = new Promise<void>((resolve) => { reading = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pass = run.talk([{ role: "user", text: "How did the backup go?" }, { role: "bot", text: "I checked the laptop backup." }], async (prompt) => {
      reading();
      await held;
      return JSON.stringify([{ kind: "done", fact: "A1", quote: botLinesIn(prompt)[0] }]);
    });
    await read;
    run.say({ role: "user", text: "Change that task to the tax return instead." });
    const record = run.record();
    const retitled = mergeTaskAsks(record, [{ id: "A1", ask: "Review the tax return", status: "open" }], Date.now() + 1);
    if ("error" in retitled) throw new Error(retitled.error);
    run.write({ ...record, asks: retitled.asks, lastAskId: retitled.lastAskId });
    release();
    await pass;
    expect(run.asks()).toEqual([expect.objectContaining({ id: "A1", ask: "Review the tax return", status: "open" })]);
    run.dispose();
  });

  it("closes only the promise a report names", async () => {
    const run = replay("two-open");
    await run.talk([ask, { role: "bot", text: `${LAPTOP} I'll email the contract later.` }], filesEvery);
    await run.talk([ask, { role: "bot", text: "I checked the laptop backup." }], async (prompt) => JSON.stringify([{ kind: "done", fact: "A1", quote: botLinesIn(prompt)[0] }]));
    expect(run.asks().map((item) => [item.id, item.status])).toEqual([["A1", "done"], ["A2", "open"]]);
    run.dispose();
  });

  it.each([
    { name: "checked", helper: filesEvery, rows: [{ role: "bot", text: `${LAPTOP} I checked the laptop backup just now.` }] },
    { name: "checked", helper: skipsDone, rows: [{ role: "bot", text: `${LAPTOP} I checked the laptop backup just now.` }] },
    { name: "backed up", helper: filesEvery, rows: [{ role: "bot", text: LAPTOP }, { role: "bot", text: "I backed it up just now." }] },
    { name: "backed up", helper: skipsDone, rows: [{ role: "bot", text: LAPTOP }, { role: "bot", text: "I backed it up just now." }] },
    { name: "withdrawn", helper: filesEvery, rows: [{ role: "bot", text: LAPTOP }, { role: "bot", text: "Actually, scratch that. I won't be able to do it." }] },
  ] satisfies { name: string; helper: NoteGenerator; rows: MissRow[] }[])("files nothing for a promise $name later in the same reply ($helper.name)", async ({ name, helper, rows }) => {
    const run = replay(`same-reply-${name.replace(/\W+/g, "-")}-${helper.name}`);
    await run.talk([ask, ...rows], helper);
    expect(run.asks()).toEqual([]);
    run.dispose();
  });

  const nine = ["invoice expenses", "printer hardware", "router settings", "shipment dates", "proposal figures", "docket entries", "contract terms", "server logs", "meeting notes"]
    .map((what) => `I'll review ${what} tomorrow.`);
  it.each([
    { name: "a promise at a clock time", rows: [{ role: "bot", text: "I'll email the signed invoice at 4 pm." }], kept: ["I'll email the signed invoice at 4 pm."] },
    { name: "a promise before a closing thanks row", rows: [{ role: "bot", text: LAPTOP }, { role: "bot", text: "Thanks for the details." }], kept: [LAPTOP] },
    {
      name: "promises for PC A and PC B",
      rows: [{ role: "bot", text: "I'll check the nightly backup on PC A tomorrow. I'll check the nightly backup on PC B tomorrow." }],
      kept: ["I'll check the nightly backup on PC A tomorrow.", "I'll check the nightly backup on PC B tomorrow."],
    },
    { name: "nine promises in one reply", rows: [{ role: "bot", text: nine.join(" ") }], kept: nine },
  ] satisfies { name: string; rows: MissRow[]; kept: string[] }[])("files $name", async ({ name, rows, kept }) => {
    const run = replay(name.replace(/\W+/g, "-"));
    await run.talk([ask, ...rows], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual(kept);
    run.dispose();
  });

  it("keeps a new promise after a withdrawn one", async () => {
    const run = replay("withdrawn-then-new");
    await run.talk([ask, { role: "bot", text: `${LAPTOP} Never mind, I'll check the desktop backup tonight.` }], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual(["Never mind, I'll check the desktop backup tonight."]);
    run.dispose();
  });

  it("keeps a later promise for PC B apart from the open one for PC A", async () => {
    const run = replay("pc-b-later");
    await run.talk([ask, { role: "bot", text: "I'll check the nightly backup on PC A tomorrow." }], filesEvery);
    await run.talk([ask, { role: "bot", text: "I'll check the nightly backup on PC B tomorrow." }], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual(["I'll check the nightly backup on PC A tomorrow.", "I'll check the nightly backup on PC B tomorrow."]);
    run.dispose();
  });
});

describe("memory replay: gate 2073B cases", () => {
  const invoice = "I'll email the signed invoice tomorrow at 4 pm.";
  it("merges the same deadline written as 4:00 pm", async () => {
    const run = replay("clock-repeat");
    await run.talk([ask, { role: "bot", text: invoice }], filesEvery);
    await run.talk([{ role: "user", text: "Please confirm." }, { role: "bot", text: invoice.replace("4 pm", "4:00 pm") }], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual([invoice]);
    run.dispose();
  });

  it("keeps 4 pm and 4:30 pm apart", async () => {
    const run = replay("clock-distinct");
    await run.talk([ask, { role: "bot", text: invoice }], filesEvery);
    await run.talk([ask, { role: "bot", text: invoice.replace("4 pm", "4:30 pm") }], filesEvery);
    expect(run.asks()).toHaveLength(2);
    run.dispose();
  });

  it("merges a reworded repeat the note-taker ties to the open promise", async () => {
    const run = replay("tied-repeat");
    await run.talk([ask, { role: "bot", text: LAPTOP }], filesEvery);
    const restated = "I'll verify the notebook backup later.";
    await run.talk([ask, { role: "bot", text: restated }], async () => JSON.stringify([{ kind: "promise", fact: restated, quote: restated, replaces: "A1" }]));
    expect(run.asks().map((item) => item.ask)).toEqual([LAPTOP]);
    run.dispose();
  });

  it.each([
    { name: "payroll and billing backups in one reply", text: "I'll check the nightly payroll backup tomorrow. I'll check the nightly billing backup tomorrow.", kept: ["I'll check the nightly payroll backup tomorrow.", "I'll check the nightly billing backup tomorrow."] },
    { name: "a promise at noon", text: "I'll email the signed invoice at noon.", kept: ["I'll email the signed invoice at noon."] },
  ])("files $name", async ({ name, text, kept }) => {
    const run = replay(name.replace(/\W+/g, "-"));
    await run.talk([ask, { role: "bot", text }], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual(kept);
    run.dispose();
  });
});

describe("memory replay: gate 2073C cases", () => {
  const invoice = "I'll email the signed invoice tomorrow.";
  const notify = "I will notify you tomorrow when the invoice is ready.";
  // the gate's note-taker: every "I'll" or "I will" line it is shown is a promise
  const filesWill: NoteGenerator = async (prompt) => JSON.stringify(botLinesIn(prompt).filter((line) => /\bI(?:'ll| will)\b/i.test(line)).map((line) => ({ kind: "promise", fact: line, quote: line })));
  it.each([
    { name: "a promise to notify", rows: [notify], kept: [notify] },
    { name: "a promise before an unrelated report done just now", rows: [invoice, "I checked the laptop backup just now."], kept: [invoice] },
    { name: "a promise before an unrelated refusal", rows: [invoice, "I can't make it to the meeting today."], kept: [invoice] },
    { name: "only the promise a scratch-that takes back", rows: [invoice, LAPTOP, "Actually, scratch that. I won't be able to do it."], kept: [invoice] },
    { name: "only the promise a cancel names", rows: [`${invoice} ${LAPTOP} Cancel that invoice email. The backup is still on.`], kept: [LAPTOP] },
    { name: "one ask for a promise restated in the same reply", rows: [LAPTOP, `To confirm, ${LAPTOP}`], kept: [LAPTOP] },
    { name: "nothing for a refusal", rows: ["I will not email the signed invoice tomorrow."], kept: [] },
  ])("files $name", async ({ name, rows, kept }) => {
    const run = replay(name.replace(/\W+/g, "-"));
    await run.talk([ask, ...rows.map((text) => ({ role: "bot", text }) as const)], filesWill);
    expect(run.asks().map((item) => item.ask)).toEqual(kept);
    run.dispose();
  });

  it("files a repeat tied to a promise retitled while the note-taker read it", async () => {
    const run = replay("tied-while-retitled");
    await run.talk([ask, { role: "bot", text: LAPTOP }], filesEvery);
    const restated = "I'll verify the notebook backup later.";
    let reading!: () => void;
    let release!: () => void;
    const read = new Promise<void>((resolve) => { reading = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const pass = run.talk([{ role: "user", text: "Please confirm the backup." }, { role: "bot", text: restated }], async () => {
      reading();
      await held;
      return JSON.stringify([{ kind: "promise", fact: restated, quote: restated, replaces: "A1" }]);
    });
    await read;
    const record = run.record();
    const retitled = mergeTaskAsks(record, [{ id: "A1", ask: "Review the tax return", status: "open" }], Date.now() + 1);
    if ("error" in retitled) throw new Error(retitled.error);
    run.write({ ...record, asks: retitled.asks, lastAskId: retitled.lastAskId });
    release();
    await pass;
    expect(run.asks().map((item) => item.ask)).toEqual(["Review the tax return", restated]);
    run.dispose();
  });
});
