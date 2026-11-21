import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { createMemoryPass, namesPromise, type NoteGenerator } from "./memory-pass.ts";
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
// the gate's note-taker: every "I'll" or "I will" line it is shown is a promise
const filesWill: NoteGenerator = async (prompt) => JSON.stringify(botLinesIn(prompt).filter((line) => /\bI(?:'ll| will)\b/i.test(line)).map((line) => ({ kind: "promise", fact: line, quote: line })));

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
    { name: "checked", helper: skipsDone, rows: [{ role: "bot", text: `${LAPTOP} I checked the laptop backup just now.` }] },
    { name: "backed up", helper: skipsDone, rows: [{ role: "bot", text: LAPTOP }, { role: "bot", text: "I backed it up just now." }] },
    { name: "withdrawn", helper: filesEvery, rows: [{ role: "bot", text: LAPTOP }, { role: "bot", text: "Actually, scratch that. I won't be able to do it." }] },
  ] satisfies { name: string; helper: NoteGenerator; rows: MissRow[] }[])("files nothing for a promise $name later in the same reply ($helper.name)", async ({ name, helper, rows }) => {
    const run = replay(`same-reply-${name.replace(/\W+/g, "-")}-${helper.name}`);
    await run.talk([ask, ...rows], helper);
    expect(run.asks()).toEqual([]);
    run.dispose();
  });

  it.each([
    { name: "checked", why: "only the note-taker judges a done line", rows: [{ role: "bot", text: `${LAPTOP} I checked the laptop backup just now.` }] },
    { name: "backed up", why: "only the note-taker judges a done line", rows: [{ role: "bot", text: LAPTOP }, { role: "bot", text: "I backed it up just now." }] },
  ] satisfies { name: string; why: string; rows: MissRow[] }[])("keeps a promise $name later in the same reply (filesEvery): $why", async ({ name, rows }) => {
    const run = replay(`same-reply-${name.replace(/\W+/g, "-")}-filesEvery`);
    await run.talk([ask, ...rows], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual([LAPTOP]);
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

  it("keeps the open promise beside a never-mind that names another (no clear tie)", async () => {
    const run = replay("withdrawn-then-new");
    await run.talk([ask, { role: "bot", text: `${LAPTOP} Never mind, I'll check the desktop backup tonight.` }], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual([LAPTOP, "Never mind, I'll check the desktop backup tonight."]);
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
  it.each([
    { name: "a promise to notify", rows: [notify], kept: [notify] },
    { name: "a promise before an unrelated report done just now", rows: [invoice, "I checked the laptop backup just now."], kept: [invoice] },
    { name: "a promise before an unrelated refusal", rows: [invoice, "I can't make it to the meeting today."], kept: [invoice] },
    { name: "only the promise a scratch-that takes back", rows: [invoice, LAPTOP, "Actually, scratch that. I won't be able to do it."], kept: [invoice] },
    { name: "both, as the cancel never says signed", rows: [`${invoice} ${LAPTOP} Cancel that invoice email. The backup is still on.`], kept: [invoice, LAPTOP] },
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

describe("memory replay: gate 2073D cases", () => {
  const invoice = "I'll email the signed invoice tomorrow.";
  const agreement = "I'll proofread the agreement tonight.";
  const contract = "I'll review the contract tomorrow.";
  const decisions = "I'll document the meeting decisions tomorrow.";
  const taxes = "I'll file the tax return tomorrow.";
  const toAlice = "I'll send the agenda to Alice tomorrow.";
  const toManager = "I'll send the agenda to Alice's manager tomorrow.";
  const product = "I'll email the product report tomorrow.";
  const production = "I'll email the production report tomorrow.";
  const electrician = "I'll call the electrician tomorrow.";

  it("removes a promise only when a line names every word of its object as whole words", () => {
    const ties: [string, string][] = [
      ["Cancel that production report.", production],
      ["Never mind the laptop backup.", LAPTOP],
      ["I called the electrician just now.", electrician],
    ];
    const loose: [string, string][] = [
      ["Cancel that production report.", product],
      ["Cancel that product report.", production],
      ["Cancel that contact request.", contract],
      ["I emailed my sister just now.", invoice],
      ["Cancel that invoice email.", invoice],
      ["I backed it up just now.", LAPTOP],
      ["I won at Go just now.", taxes],
      ["I sent the agenda to Alice just now.", toManager],
      ["I did not email the signed invoice just now.", invoice],
      ["I cannot reach the electrician just now.", electrician],
      ["Sorry, I won't be able to check the laptop backup.", LAPTOP],
    ];
    expect(ties.filter(([line, promise]) => !namesPromise(line, promise))).toEqual([]);
    expect(loose.filter(([line, promise]) => namesPromise(line, promise))).toEqual([]);
  });

  it.each([
    { name: "an email to a sister done just now", rows: [invoice, agreement, "I emailed my sister just now."], kept: [invoice, agreement] },
    { name: "a cancelled email subscription", rows: [invoice, agreement, "Cancel that email subscription."], kept: [invoice, agreement] },
    { name: "a refused club meeting", rows: [decisions, agreement, "I can't make it to the club meeting today."], kept: [decisions, agreement] },
    { name: "an email not sent just now", rows: [invoice, agreement, "I did not email the signed invoice just now."], kept: [invoice, agreement] },
    { name: "a cancelled contact request", rows: [contract, agreement, "Cancel that contact request."], kept: [contract, agreement] },
    { name: "a game won at Go just now", rows: [taxes, "I won at Go just now."], kept: [taxes] },
    { name: "an extra recipient on the same agenda", rows: [toAlice, toManager], kept: [toAlice, toManager] },
    { name: "an agenda drafted just now", rows: ["I'll send the agenda tonight. I drafted the agenda just now."], kept: ["I'll send the agenda tonight."] },
    { name: "an invoice signed just now", rows: [`${invoice} I signed the invoice just now.`], kept: [invoice] },
    { name: "an electrician emailed just now", rows: [`${electrician} I emailed the electrician just now.`], kept: [electrician] },
    { name: "a refusal to finish the same report", rows: ["I'll email the report tomorrow. I won't be able to finish the report today."], kept: ["I'll email the report tomorrow."] },
  ])("keeps every promise: $name", async ({ name, rows, kept }) => {
    const run = replay(name.replace(/\W+/g, "-"));
    await run.talk([ask, ...rows.map((text) => ({ role: "bot", text }) as const)], filesWill);
    expect(run.asks().map((item) => item.ask)).toEqual(kept);
    run.dispose();
  });

  it.each([
    { name: "production first", rows: [production, product, "Cancel that production report."] },
    { name: "product first", rows: [`${product} ${production} Cancel that production report.`] },
  ])("drops only the production report a cancel names ($name)", async ({ name, rows }) => {
    const run = replay(`cancel-${name.replace(/\W+/g, "-")}`);
    await run.talk([ask, ...rows.map((text) => ({ role: "bot", text }) as const)], filesWill);
    expect(run.asks().map((item) => item.ask)).toEqual([product]);
    run.dispose();
  });

  it.each([
    { report: "I called the electrician just now.", status: "done" },
    { report: "I called the plumber just now.", status: "open" },
  ])("lets a done id close a promise only when its quote names it ($report)", async ({ report, status }) => {
    const run = replay(`done-id-${status}`);
    await run.talk([{ role: "user", text: "Please call the electrician tomorrow and send the agenda tonight." }, { role: "bot", text: `${electrician} I'll send the agenda tonight.` }], filesWill);
    await run.talk([{ role: "user", text: "Who did you call today?" }, { role: "bot", text: report }], async (prompt) => JSON.stringify([{ kind: "done", fact: "A1", quote: botLinesIn(prompt)[0] }]));
    expect(run.asks().map((item) => [item.ask, item.status])).toEqual([[electrician, status], ["I'll send the agenda tonight.", "open"]]);
    run.dispose();
  });
});

describe("memory replay: gate 2073E cases", () => {
  const draft = "I'll draft the announcement tomorrow.";
  const publish = "I'll publish the announcement tonight.";
  const unpublish = "Cancel that plan to publish the announcement.";
  const taxi = "I'll reserve the taxi tomorrow.";
  const hotel = "I'll book the hotel room tomorrow.";
  const renew = "I'll renew the subscription tomorrow.";
  const toAlice = "I'll send the agenda to Alice tomorrow.";
  const toManager = "I'll send the agenda to Alice's manager tomorrow.";
  const monday = "I'll book the pickup on Monday.";
  const friday = "I'll book the pickup on Friday.";
  const agenda = "I'll send the agenda tomorrow.";
  const print = "I'll print the agenda tonight.";

  it("removes a promise only when a line names its whole object and its action, and no other promise as well", () => {
    const ties: [string, string, string[]][] = [
      [unpublish, publish, [draft]],
      ["Cancel that Friday pickup.", friday, [monday]],
      ["I printed the agenda just now.", print, [agenda]],
    ];
    const loose: [string, string, string[]][] = [
      [unpublish, draft, [publish]],
      [unpublish, draft, []],
      ["Cancel that taxi, but keep the hotel room.", hotel, [taxi]],
      ["If you want to cancel that subscription later, let me know.", renew, []],
      ['The button says "Cancel that subscription".', renew, []],
      ["Cancel that agenda delivery to Alice's manager.", toAlice, [toManager]],
      ["Cancel that Friday pickup.", monday, [friday]],
      ["Cancel that Friday pickup.", monday, []],
      ["Cancel that pickup.", monday, [friday]],
      ["I printed the agenda just now.", agenda, [print]],
      ["I printed the agenda just now.", agenda, []],
    ];
    expect(ties.filter(([line, promise, others]) => !namesPromise(line, promise, others))).toEqual([]);
    expect(loose.filter(([line, promise, others]) => namesPromise(line, promise, others))).toEqual([]);
  });

  it.each([
    { name: "a draft beside a cancelled publishing", rows: [draft, publish, unpublish], kept: [draft] },
    { name: "a draft beside a cancelled publishing promised first", rows: [publish, draft, unpublish], kept: [draft] },
    { name: "a draft when the cancel names only publishing", rows: [draft, unpublish], kept: [draft] },
    { name: "both, as a cancel naming the taxi and the hotel singles out neither", rows: [taxi, hotel, "Cancel that taxi, but keep the hotel room."], kept: [taxi, hotel] },
    { name: "a renewal beside a cancel offered for later", rows: [renew, "If you want to cancel that subscription later, let me know."], kept: [renew] },
    { name: "a renewal beside a quoted cancel button", rows: [renew, 'The button says "Cancel that subscription".'], kept: [renew] },
    { name: "both agendas, as a delivery never names the sending", rows: [toAlice, toManager, "Cancel that agenda delivery to Alice's manager."], kept: [toAlice, toManager] },
    { name: "the Monday pickup beside a cancelled Friday one", rows: [monday, friday, "Cancel that Friday pickup."], kept: [monday] },
    { name: "both pickups, as the cancel names neither day", rows: [monday, friday, "Cancel that pickup."], kept: [monday, friday] },
    { name: "a copy for Alice and one for Bob", rows: ["For Alice, I'll send the agenda tomorrow.", "For Bob, I'll send the agenda tomorrow."], kept: ["For Alice, I'll send the agenda tomorrow.", "For Bob, I'll send the agenda tomorrow."] },
    { name: "a restart on the laptop and one on the desktop", rows: ["On the laptop, I'll restart the server tomorrow.", "On the desktop, I'll restart the server tomorrow."], kept: ["On the laptop, I'll restart the server tomorrow.", "On the desktop, I'll restart the server tomorrow."] },
  ])("keeps $name", async ({ name, rows, kept }) => {
    const run = replay(name.replace(/\W+/g, "-"));
    await run.talk([ask, { role: "bot", text: rows.join(" ") }], filesWill);
    expect(run.asks().map((item) => item.ask)).toEqual(kept);
    run.dispose();
  });

  it.each([
    { name: "another action on the same agenda", promises: [agenda, print], id: "A1", statuses: ["open", "open"] },
    { name: "the action it names", promises: [agenda, print], id: "A2", statuses: ["open", "done"] },
    { name: "the only open promise when the report names another action", promises: [agenda], id: "A1", statuses: ["open"] },
  ])("lets a done id close $name only when its quote names that action", async ({ name, promises, id, statuses }) => {
    const run = replay(`done-${name.replace(/\W+/g, "-")}`);
    await run.talk([{ role: "user", text: "Please handle these tasks." }, { role: "bot", text: promises.join(" ") }], filesWill);
    await run.talk([{ role: "user", text: "What did you finish?" }, { role: "bot", text: "I printed the agenda just now." }], async (prompt) => JSON.stringify([{ kind: "done", fact: id, quote: botLinesIn(prompt)[0] }]));
    expect(run.asks().map((item) => item.status)).toEqual(statuses);
    run.dispose();
  });
});

describe("memory replay: gate 2073F cases", () => {
  const friday = "I'll book the pickup on Friday.";
  const monday = "I'll email the invoice on Monday.";
  const invoice = "I'll email the signed invoice tomorrow.";
  const toAlice = "I'll email Alice about Bob tomorrow.";
  const ifDisk = "Cancel that plan to check the laptop backup only if the disk fails.";

  it("removes a promise a cancel names by its time alone, never one whose object comes in another order or a hedged line names", () => {
    const ties: [string, string, string[]][] = [
      ["Cancel that for Friday.", friday, [monday]],
      ["Cancel that for Friday.", friday, []],
    ];
    const loose: [string, string, string[]][] = [
      ["Cancel that for Friday.", monday, [friday]],
      ["Cancel that for tomorrow.", LAPTOP, [invoice]],
      ["Cancel that email to Bob about Alice.", toAlice, []],
      ["I emailed Bob about Alice just now.", toAlice, []],
      [ifDisk, LAPTOP, []],
    ];
    expect(ties.filter(([line, promise, others]) => !namesPromise(line, promise, others))).toEqual([]);
    expect(loose.filter(([line, promise, others]) => namesPromise(line, promise, others))).toEqual([]);
  });

  it.each([
    { name: "the Monday invoice beside a cancel for Friday", rows: [friday, monday, "Cancel that for Friday."], kept: [monday] },
    { name: "the Monday invoice beside a cancel for Friday promised last", rows: [monday, friday, "Cancel that for Friday."], kept: [monday] },
    { name: "the backup beside a never-mind about the user", rows: [LAPTOP, "Never mind me."], kept: [LAPTOP] },
    { name: "the backup beside a cancel if it has to", rows: [LAPTOP, "Cancel that if we have to."], kept: [LAPTOP] },
    { name: "the backup beside a cancel only if the disk fails", rows: [LAPTOP, ifDisk], kept: [LAPTOP] },
    { name: "the email to Alice beside a cancel of the one to Bob about Alice", rows: [toAlice, "Cancel that email to Bob about Alice."], kept: [toAlice] },
    { name: "the backup when a scratch-that follows another statement", rows: [LAPTOP, "The light is green.", "Actually, scratch that."], kept: [LAPTOP] },
  ])("keeps $name", async ({ name, rows, kept }) => {
    const run = replay(name.replace(/\W+/g, "-"));
    await run.talk([ask, { role: "bot", text: rows.join(" ") }], filesWill);
    expect(run.asks().map((item) => item.ask)).toEqual(kept);
    run.dispose();
  });

  it("files the Monday invoice when the note-taker quotes only it beside a cancel for Friday", async () => {
    const run = replay("monday-only-helper");
    await run.talk([ask, { role: "bot", text: `${friday} ${monday} Cancel that for Friday.` }], async (prompt) => promised(botLinesIn(prompt).filter((line) => line === monday)));
    expect(run.asks().map((item) => item.ask)).toEqual([monday]);
    run.dispose();
  });

  it("files a billing backup promised a turn after the payroll one", async () => {
    const payroll = "I'll check the nightly payroll backup tomorrow.";
    const billing = "I'll check the nightly billing backup tomorrow.";
    const run = replay("payroll-later");
    await run.talk([ask, { role: "bot", text: payroll }], filesEvery);
    await run.talk([ask, { role: "bot", text: billing }], filesEvery);
    expect(run.asks().map((item) => item.ask)).toEqual([payroll, billing]);
    run.dispose();
  });

  it.each([
    { name: "a report naming Bob and Alice the other way round", promise: toAlice, report: "I emailed Bob about Alice just now.", quote: "I emailed Bob about Alice just now." },
    { name: "a quote cut from a negated report", promise: LAPTOP, report: "I never checked the laptop backup just now.", quote: "checked the laptop backup just now" },
  ])("keeps a promise open beside $name", async ({ name, promise, report, quote }) => {
    const run = replay(`open-${name.replace(/\W+/g, "-")}`);
    await run.talk([{ role: "user", text: "Please handle these tasks." }, { role: "bot", text: promise }], filesWill);
    await run.talk([{ role: "user", text: "What did you finish?" }, { role: "bot", text: report }], async () => JSON.stringify([{ kind: "done", fact: "A1", quote }]));
    expect(run.asks().map((item) => item.status)).toEqual(["open"]);
    run.dispose();
  });
});
