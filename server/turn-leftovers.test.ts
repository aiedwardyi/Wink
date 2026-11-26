import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { ASK_VERDICT_MS, asksBlock, asksNudge, fileLeftovers, type TaskAsk } from "./task-asks.ts";
import { answeredRows, turnLeftovers } from "./turn-leftovers.ts";

let n = 0;
const user = (text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, role: "user", kind: "text", text, at: n, ...extra });
const bot = (text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, role: "bot", kind: "text", text, at: n, ...extra });
const tool = (summary = "", ok = true): Message => ({ id: `m${++n}`, role: "bot", kind: "activity", tool: { name: "Read", ok, summary }, at: n });
const ask = (id: string, text: string, status: TaskAsk["status"], kind?: TaskAsk["kind"]): TaskAsk => {
  const filed: TaskAsk = { id, ask: text, status, at: 1, changedAt: 1 };
  if (kind) filed.kind = kind;
  return filed;
};
const promise = (text: string) => ({ ask: text, promise: true as const });
// one settled turn: the asks it leaves, filed beside what was there
const settle = (rows: Message[], asks: TaskAsk[]) => fileLeftovers({ asks, lastAskId: asks.length }, turnLeftovers(rows), 9)?.asks ?? asks;

describe("turn leftovers", () => {
  it("files the promises Codex's hidden notes made and the question a steer talked over, each its own ask", () => {
    const left = turnLeftovers([
      user("How does Wink keep my work when I switch models? Also keep the picker changes moving."),
      bot("I'll answer the model-switch question from how Wink actually stores chats and tasks.", { summarized: true }),
      bot("I'll keep the picker changes moving.", { summarized: true }),
      user("What color should the ramp be?", { steered: true }),
      bot("The ramp should be blue, like the toolbar."),
    ]);
    expect(left).toEqual([
      promise("I'll answer the model-switch question from how Wink actually stores chats and tasks."),
      promise("I'll keep the picker changes moving."),
      { ask: "How does Wink keep my work when I switch models?" },
    ]);
    const saved = fileLeftovers(undefined, left, 5)!;
    expect(saved.asks.map((item) => [item.id, item.status, item.kind])).toEqual([["A1", "open", "promise"], ["A2", "open", "promise"], ["A3", "open", undefined]]);
    expect(saved.asks[0]!.ask).toHaveLength(80);
    expect(asksBlock(saved.asks, 5)).toContain("- A2 open promise unchecked 01-01: I'll keep the picker changes moving.");
  });

  it("files every kept promise of the turn, since no later line or call decides it is done", () => {
    const update = "I'll update the release notes.";
    // a Read is not the update, PC B is not PC A, and "Logs are clean" is for the next engine to check
    expect(turnLeftovers([user("Go on"), bot(update), tool("RELEASE-NOTES.md"), bot("Back soon.")])).toEqual([promise(update)]);
    expect(turnLeftovers([user("go on"), bot("I'll update PC A."), bot("PC B is updated.")])).toEqual([promise("I'll update PC A.")]);
    expect(turnLeftovers([user("go on"), bot("I'll update folder 1."), bot("folder 2 is updated.")])).toEqual([promise("I'll update folder 1.")]);
    expect(turnLeftovers([user("Check the logs"), bot("I'll check the logs first."), tool(), bot("Logs are clean.")])).toEqual([promise("I'll check the logs first.")]);
    expect(turnLeftovers([user("Release?"), bot("I'll read the release notes."), tool("RELEASE-NOTES.md", false), bot("I couldn't read the release notes.")])).toEqual([promise("I'll read the release notes."), { ask: "Release?" }]);
  });

  it("files a final promise on a time or a named object, never an offer or a vague one", () => {
    expect(turnLeftovers([user("Please fix the picker"), bot("I'll update the picker labels.")])).toEqual([promise("I'll update the picker labels.")]);
    expect(turnLeftovers([user("Please review it"), tool(), bot("I'll review the invoice tomorrow.")])).toEqual([promise("I'll review the invoice tomorrow.")]);
    expect(turnLeftovers([user("Fix it"), tool(), bot("Fixed. I'll keep it simple.")])).toEqual([]);
    expect(turnLeftovers([user("Ship it"), tool(), bot("Shipped. I'll keep an eye on it.")])).toEqual([]);
    expect(turnLeftovers([user("Tests please"), bot("If you want, I'll add tests for the parser."), tool(), bot("Done.")])).toEqual([]);
    expect(turnLeftovers([user("고쳐 주세요"), bot("API를 수정할게요.")])).toEqual([promise("API를 수정할게요.")]);
    expect(turnLeftovers([user("고쳐 주세요"), bot("설정 파일을 수정할게요.")])).toEqual([promise("설정 파일을 수정할게요.")]);
    expect(turnLeftovers([user("고쳐 주세요"), tool(), bot("확인할게요.")])).toEqual([]);
    // a quoted example is no promise; a quoted name inside one is
    expect(turnLeftovers([user("Go on"), bot(`The sentence "I'll delete the backup tomorrow." is in the future tense.`), bot("Back soon.")])).toEqual([]);
    expect(turnLeftovers([user("Go on"), bot(`I'll rename the "Save" button.`)])).toEqual([promise(`I'll rename the "Save" button.`)]);
    expect(turnLeftovers([user("Go on"), bot(`I'll rename "Save".`)])).toEqual([promise(`I'll rename "Save".`)]);
    const kept = ["I'll fix the API.", "I'll check if the backup exists.", "I'll implement the feature you want."];
    expect(turnLeftovers([user("Keep going."), ...kept.map((line) => bot(line, { summarized: true })), bot("Back soon.")])).toEqual(kept.map(promise));
  });

  it("keeps a question no shown reply line answers: an unrelated reply, a deferral, or an answer to another question only", () => {
    const shortcuts = { ask: "Where are the keyboard shortcuts documented?" };
    expect(turnLeftovers([user(shortcuts.ask), bot("Blue.")])).toEqual([shortcuts]);
    expect(turnLeftovers([user(shortcuts.ask), bot("I'll get back to you.")])).toEqual([shortcuts]);
    expect(turnLeftovers([user(shortcuts.ask), bot("The keyboard shortcuts are a good question. I'll get back to you.")])).toEqual([shortcuts]);
    expect(turnLeftovers([user(shortcuts.ask), bot("I'm checking where the keyboard shortcuts are documented.")])).toEqual([shortcuts]);
    expect(turnLeftovers([user(shortcuts.ask), bot("I still need to check where the keyboard shortcuts are documented.")])).toEqual([shortcuts]);
    expect(turnLeftovers([user(shortcuts.ask), bot("I haven't checked where the keyboard shortcuts are documented yet.")])).toEqual([shortcuts]);
    expect(turnLeftovers([user(shortcuts.ask), bot("I didn't find where the keyboard shortcuts are documented.")])).toEqual([shortcuts]);
    // a plain negative still answers
    expect(turnLeftovers([user(shortcuts.ask), bot("The keyboard shortcuts are not documented anywhere yet but GUIDE.md lists some.")])).toEqual([shortcuts]);
    expect(turnLeftovers([user(shortcuts.ask), bot("The keyboard shortcuts are not documented outside GUIDE.md.")])).toEqual([]);
    const two = user(`What color should the ramp be? ${shortcuts.ask}`);
    expect(turnLeftovers([two, bot("The ramp should be blue.")])).toEqual([shortcuts]);
    expect(turnLeftovers([two, bot("The ramp should be blue."), user("What size?", { steered: true }), bot("The size is 14 px.")])).toEqual([shortcuts]);
    // a line that says it and more answers it
    expect(turnLeftovers([user("Why is CI red?"), user("Color?", { steered: true }), bot("Blue. CI is red from a flaky test.")])).toEqual([{ ask: "Color?" }]);
    expect(turnLeftovers([user(shortcuts.ask), bot("The keyboard shortcuts are documented in GUIDE.md.")])).toEqual([]);
  });

  it("reads every message the turn answered, one folded in while it set up too", () => {
    const first = user("Where are the keyboard shortcuts documented?");
    const folded = user("What color should the ramp be?", { parentId: first.id });
    const reply = bot("Blue.", { parentId: folded.id });
    const rows = new Map([bot("Earlier reply."), { ...first, parentId: "m-earlier" }, folded, reply].map((row) => [row.id, row]));
    rows.set("m-earlier", { ...bot("Earlier reply."), id: "m-earlier" });
    const opening = answeredRows(reply, (id) => rows.get(id));
    expect(opening.map((row) => row.text)).toEqual([first.text, folded.text]);
    expect(turnLeftovers([...opening, reply])).toEqual([{ ask: first.text }, { ask: folded.text }]);
    expect(answeredRows(undefined, (id) => rows.get(id))).toEqual([]);
  });

  it("keeps a question the quick helper handed into the turn as a steer, and none it answered", () => {
    expect(turnLeftovers([user("What font is it?"), user("And the ramp color?", { steered: true, quick: { state: "handoff" } }), bot("The ramp color is blue, like the toolbar.")])).toEqual([{ ask: "What font is it?" }]);
  });

  it("drops a promise a take-back names, or a bare one the promise right before it; a hedged one drops nothing", () => {
    expect(turnLeftovers([user("Report"), bot("I'll send the report tomorrow. Actually, scratch that.")])).toEqual([]);
    expect(turnLeftovers([user("Report"), bot("I'll send the report tomorrow. I'll email Bob tonight. Cancel that report.")])).toEqual([promise("I'll email Bob tonight.")]);
    expect(turnLeftovers([user("Report"), bot("I'll send the report tomorrow. Cancel that if we have to.")])).toEqual([promise("I'll send the report tomorrow.")]);
  });

  it("files a job a line says is running as open with that line as its note, never building", () => {
    const running = turnLeftovers([user("Export the data"), bot("I'll run the data export in the background."), tool("export.ps1"), bot("Export running as PID 4128, leave it alone.")]);
    expect(running).toEqual([{ ...promise("I'll run the data export in the background."), note: "Export running as PID 4128, leave it alone." }]);
    const saved = fileLeftovers(undefined, running, 5)!;
    expect(saved.asks[0]).toMatchObject({ status: "open", kind: "promise", ref: "Export running as PID 4128, leave it alone." });
    const next = asksNudge(saved.asks, 6, "ok");
    expect(next).toContain("- A1 open promise unchecked 01-01: I'll run the data export in the background. (Export running as PID 4128, leave it alone.)");
    expect(next).toContain("running processes first");
    expect(next).toContain("never start one twice");
    // a running line about other work is no note
    expect(turnLeftovers([user("go on"), bot("I'll update the picker labels."), bot("The backup is running.")])).toEqual([promise("I'll update the picker labels.")]);
  });

  it("files a narrated turn's first three promises and points at the transcript for the rest, in under 2 ms", () => {
    const rows = [user("Do the release"), ...Array.from({ length: 60 }, (_, i) => [bot(`I'll check step ${i} of the release notes.`), tool("RELEASE-NOTES.md"), bot(`Step ${i} is fine.`)]).flat(), bot(`All done. ${"More detail on the release. ".repeat(150)}`)];
    expect(turnLeftovers(rows)).toHaveLength(60);
    const saved = fileLeftovers(undefined, turnLeftovers(rows), 9)!;
    expect(saved.asks.map((item) => item.ask)).toEqual([0, 1, 2].map((i) => `I'll check step ${i} of the release notes.`));
    expect(saved.asks[2]!.ref).toBe(`57 more "I'll" in that turn's transcript`);
    const started = performance.now();
    for (let i = 0; i < 20; i++) fileLeftovers(undefined, turnLeftovers(rows), 9);
    expect((performance.now() - started) / 20).toBeLessThan(2);
  });

  it("takes only an exact repeat of the same kind as the ask it repeats; anything else files beside it", () => {
    const filed = [ask("A1", "I'll keep the picker changes moving.", "open", "promise"), ask("A2", "Pick the ramp color", "open"), ask("A3", "I'll fix the API", "done", "promise"), ask("A4", "Why is CI red?", "declined")];
    const book = { asks: filed, lastAskId: 4 };
    for (const repeat of [promise("I'll keep the picker changes moving."), promise("I'll fix the API."), { ask: "Why is CI red?" }]) expect(fileLeftovers(book, [repeat], 9)).toBeNull();
    for (const status of ["open", "done", "declined"] as const) expect(fileLeftovers({ asks: [ask("A1", "Why is CI red?", status)], lastAskId: 1 }, [{ ask: "Why is CI red?" }], 9)).toBeNull();
    expect(fileLeftovers({ asks: [ask("A1", "I’ll fix the API", "done", "promise")], lastAskId: 1 }, [promise("I'll fix  the API.")], 9)).toBeNull();
    // a path's punctuation tells two targets apart
    for (const status of ["open", "done"] as const) expect(fileLeftovers({ asks: [ask("A1", "I'll update the src/foo.ts file.", status, "promise")], lastAskId: 1 }, [promise("I'll update the src-foo.ts file.")], 9)?.asks).toHaveLength(2);
    expect(fileLeftovers(undefined, [promise("I'll update the src/foo.ts file."), promise("I'll update the src-foo.ts file.")], 9)?.asks).toHaveLength(2);
    // two long promises alike up to the clip are not proven repeats
    const docs = (os: string) => promise(`I'll update the installation instructions in the documentation for the desktop app on ${os}.`);
    expect(fileLeftovers(undefined, [docs("Windows"), docs("Linux")], 9)?.asks).toHaveLength(2);
    expect(fileLeftovers({ asks: [{ ...ask("A1", "x", "done", "promise"), ask: fileLeftovers(undefined, [docs("Windows")], 9)!.asks[0]!.ask }], lastAskId: 1 }, [docs("Linux")], 9)?.asks).toHaveLength(2);
    // reworded, or the user's ask in the bot's words: one more line the next engine checks
    const saved = fileLeftovers(book, [{ ask: "What color should the ramp be?" }, promise("I'll fix the API")], 9)!;
    expect(saved.asks.slice(0, 4)).toEqual(filed);
    expect(saved.asks.slice(4)).toEqual([expect.objectContaining({ id: "A5", ask: "What color should the ramp be?", status: "open" })]);
    expect(fileLeftovers(book, [promise("Pick the ramp color")], 9)?.asks.at(-1)).toMatchObject({ id: "A5", kind: "promise" });
  });

  it("files new scope beside a done ask and keeps distinct work apart (E9)", () => {
    const icon = [ask("A1", "I'll update the icon.", "done", "promise")];
    expect(settle([user("go on"), bot("I'll update the icon and layout."), bot("Back soon.")], icon)).toEqual([...icon, expect.objectContaining({ id: "A2", ask: "I'll update the icon and layout.", status: "open", kind: "promise" })]);
    const layout = promise("I'll update the main desktop toolbar layout.");
    for (const status of ["open", "done"] as const) {
      expect(fileLeftovers({ asks: [ask("A1", "I'll update the main desktop toolbar icon.", status, "promise")], lastAskId: 1 }, [layout], 9)?.asks).toHaveLength(2);
      expect(fileLeftovers({ asks: [ask("A1", "Update the main desktop toolbar icon", status)], lastAskId: 1 }, [layout], 9)?.asks).toHaveLength(2);
    }
    expect(fileLeftovers(undefined, [promise("I'll update the main desktop toolbar icon."), layout], 9)?.asks).toHaveLength(2);
  });

  it("never closes, narrows or marks building a filed ask from what a reply says (E7 and the rest)", () => {
    const filed = [
      ask("A1", "I'll update the icon.", "open", "promise"),
      ask("A2", "I'll build the picker.", "open", "promise"),
      ask("A3", "I'll update the picker labels.", "open", "promise"),
      ask("A4", "Where are the keyboard shortcuts documented?", "open"),
      ask("A5", "I'll run the data export in the background.", "open", "promise"),
      ask("A6", "I'll update the icon and layout.", "open", "promise"),
    ];
    for (const reply of [
      "I updated the icon. Actually, the icon is not updated.",
      "I built the picker.",
      "Picker labels updated.",
      "The keyboard shortcuts are documented in GUIDE.md, and I'm checking the examples.",
      "Export running as PID 4128, leave it alone.",
      "The icon is updated.",
    ]) expect(settle([user("go on"), bot(reply)], filed)).toEqual(filed);
  });

  it("shows a newly filed item on the next turn once, unchecked, with what to check first, resumed or not", () => {
    const saved = fileLeftovers(undefined, [promise("I'll update the picker labels."), { ask: "Where are the keyboard shortcuts documented?" }], 5)!;
    const next = asksNudge(saved.asks, 6, "ok");
    expect(next).toContain("[Wink asks the last turn may have left open, unchecked - 2: check the transcript, files and running processes first");
    expect(next).toContain("- A1 open promise unchecked 01-01: I'll update the picker labels.");
    expect(next).toContain("- A2 open unchecked 01-01: Where are the keyboard shortcuts documented?");
    expect(asksNudge(saved.asks.map((item) => ({ ...item, shown: 6 })), 7, "ok")).toBe("");
    // a fresh engine's full list marks an open promise unchecked and says to close it by ID, not redo it
    expect(asksBlock(saved.asks, 6)).toContain("close each by ID or set it building with the job's ref through update_task_state; never start one twice.");
    expect(asksBlock([{ ...saved.asks[0]!, status: "building", ref: "PID 4128" }], 6)).toContain("- A1 building promise 01-01: I'll update the picker labels. (PID 4128)");
    // a carried question alone gets the same check on a fresh engine's full list
    const invoice = fileLeftovers(undefined, [{ ask: "Could you email the invoice?" }], 5)!.asks;
    expect(asksBlock(invoice, 6)).toContain("An unchecked row may be done or running already: check the transcript, files and running processes first");
    expect(asksBlock(invoice, 6)).toContain("- A1 open unchecked 01-01: Could you email the invoice?");
  });

  it("keeps a long question's mark and never nags a question or promise to be built", () => {
    const question = "Where are the keyboard shortcuts for the color picker documented, and can I change them from the settings page?";
    const filed = settle([user(question), user("Color?", { steered: true }), bot("Blue.")], []);
    expect(filed[0]).toMatchObject({ id: "A1", status: "open" });
    expect(filed[0]!.ask).toHaveLength(80);
    expect(filed[0]!.ask.endsWith("?")).toBe(true);
    const late = 9 + ASK_VERDICT_MS;
    for (const nudge of [asksNudge(filed, late, "Thanks"), asksNudge([ask("A1", "Where are the keyboard shortcuts documented?", "open"), ask("A2", "I'll update the picker labels.", "open", "promise")], late, "Thanks")]) expect(nudge).not.toMatch(/build, park or close|needs? (a )?verdict/);
  });
});
