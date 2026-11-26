import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { ASK_VERDICT_MS, asksBlock, asksNudge, fileLeftovers, type TaskAsk } from "./task-asks.ts";
import { answeredRows, turnLeftovers } from "./turn-leftovers.ts";

let n = 0;
// fixtures sit just past the epoch, which is 12-31 west of UTC: the list labels the local day
const epoch = new Date(0);
const DAY = `${String(epoch.getMonth() + 1).padStart(2, "0")}-${String(epoch.getDate()).padStart(2, "0")}`;
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
  it("files the promises Codex's hidden notes made and the question a steer talked over, each its own ask; the steer's own waits for a switch", () => {
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
      { ask: "What color should the ramp be?", held: true },
    ]);
    const saved = fileLeftovers(undefined, left, 5)!;
    expect(saved.asks.map((item) => [item.id, item.status, item.kind])).toEqual([["A1", "open", "promise"], ["A2", "open", "promise"], ["A3", "open", undefined], ["A4", "open", undefined]]);
    expect(saved.asks[0]!.ask).toHaveLength(80);
    expect(asksBlock(saved.asks, 5)).toContain(`- A2 open promise unchecked ${DAY}: I'll keep the picker changes moving.`);
  });

  it("files every kept promise of the turn, since no later line or call decides it is done", () => {
    const update = "I'll update the release notes.";
    // a Read is not the update, PC B is not PC A, and "Logs are clean" is for the next engine to check
    expect(turnLeftovers([user("Go on"), bot(update), tool("RELEASE-NOTES.md"), bot("Back soon.")])).toEqual([promise(update)]);
    expect(turnLeftovers([user("go on"), bot("I'll update PC A."), bot("PC B is updated.")])).toEqual([promise("I'll update PC A.")]);
    expect(turnLeftovers([user("go on"), bot("I'll update folder 1."), bot("folder 2 is updated.")])).toEqual([promise("I'll update folder 1.")]);
    expect(turnLeftovers([user("Check the logs"), bot("I'll check the logs first."), tool(), bot("Logs are clean.")])).toEqual([promise("I'll check the logs first.")]);
    expect(turnLeftovers([user("Release?"), bot("I'll read the release notes."), tool("RELEASE-NOTES.md", false), bot("I couldn't read the release notes.")])).toEqual([promise("I'll read the release notes."), { ask: "Release?", held: true }]);
  });

  it("files a final promise whatever its wording, never an offer or a quoted example", () => {
    expect(turnLeftovers([user("Please fix the picker"), bot("I'll update the picker labels.")])).toEqual([promise("I'll update the picker labels.")]);
    expect(turnLeftovers([user("Please review it"), tool(), bot("I'll review the invoice tomorrow.")])).toEqual([promise("I'll review the invoice tomorrow.")]);
    // a false one costs one checked line; a dropped one is lost work
    expect(turnLeftovers([user("Please proofread the draft"), tool(), bot("I'll fix typos.")])).toEqual([promise("I'll fix typos.")]);
    expect(turnLeftovers([user("Fix it"), tool(), bot("Fixed. I'll keep it simple.")])).toEqual([promise("I'll keep it simple.")]);
    expect(turnLeftovers([user("Ship it"), tool(), bot("Shipped. I'll keep an eye on it.")])).toEqual([promise("I'll keep an eye on it.")]);
    expect(turnLeftovers([user("Tests please"), bot("If you want, I'll add tests for the parser."), tool(), bot("Done.")])).toEqual([]);
    expect(turnLeftovers([user("Tests please"), bot("I'll add tests for the parser if you'd like."), tool(), bot("Done.")])).toEqual([]);
    // what the promised check is about is no offer
    expect(turnLeftovers([user("Can't open it"), tool(), bot("I'll check if you have access.")])).toEqual([promise("I'll check if you have access.")]);
    // two promises in one sentence get two IDs
    const both = turnLeftovers([user("Wrap up"), tool(), bot("I'll update the guide; I'll email the invoice, and I'll close the ticket.")]);
    expect(both).toEqual([promise("I'll update the guide"), promise("I'll email the invoice"), promise("I'll close the ticket.")]);
    expect(fileLeftovers(undefined, both, 1)?.asks.map((item) => item.id)).toEqual(["A1", "A2", "A3"]);
    expect(turnLeftovers([user("고쳐 주세요"), bot("API를 수정할게요.")])).toEqual([promise("API를 수정할게요.")]);
    expect(turnLeftovers([user("고쳐 주세요"), bot("설정 파일을 수정할게요.")])).toEqual([promise("설정 파일을 수정할게요.")]);
    expect(turnLeftovers([user("고쳐 주세요"), tool(), bot("확인할게요.")])).toEqual([promise("확인할게요.")]);
    // a quoted example is no promise; a quoted name inside one is
    expect(turnLeftovers([user("Go on"), bot(`The sentence "I'll delete the backup tomorrow." is in the future tense.`), bot("Back soon.")])).toEqual([]);
    expect(turnLeftovers([user("Go on"), bot(`I'll rename the "Save" button.`)])).toEqual([promise(`I'll rename the "Save" button.`)]);
    expect(turnLeftovers([user("Go on"), bot(`I'll rename "Save".`)])).toEqual([promise(`I'll rename "Save".`)]);
    const kept = ["I'll fix the API.", "I'll check if the backup exists.", "I'll implement the feature you want."];
    expect(turnLeftovers([user("Keep going."), ...kept.map((line) => bot(line, { summarized: true })), bot("Back soon.")])).toEqual(kept.map(promise));
  });

  it("files a question a newer message steered over and holds the newest message's for a switch, whatever the reply says", () => {
    const shortcuts = { ask: "Where are the keyboard shortcuts documented?" };
    const held = (ask: string) => ({ ask, held: true });
    for (const reply of [
      "The keyboard shortcuts changed yesterday.",
      "Blue.",
      "I still need to check where the keyboard shortcuts are documented.",
      "The keyboard shortcuts are documented in GUIDE.md.",
    ]) expect(turnLeftovers([user(shortcuts.ask), bot(reply)])).toEqual([held(shortcuts.ask)]);
    // a question no search term is left of is held too
    expect(turnLeftovers([user("Why?"), tool(), bot("Back soon.")])).toEqual([held("Why?")]);
    const two = user(`What color should the ramp be? ${shortcuts.ask}`);
    expect(turnLeftovers([two, bot("The ramp should be blue."), user("What size?", { steered: true }), bot("The size is 14 px.")])).toEqual([{ ask: "What color should the ramp be?" }, shortcuts, held("What size?")]);
    expect(turnLeftovers([user("Why is CI red?"), user("Color?", { steered: true }), bot("Blue. CI is red from a flaky test.")])).toEqual([{ ask: "Why is CI red?" }, held("Color?")]);
  });

  it("reads every message the turn answered, one folded in while it set up too", () => {
    const first = user("Where are the keyboard shortcuts documented?");
    const folded = user("What color should the ramp be?", { parentId: first.id });
    const reply = bot("Blue.", { parentId: folded.id });
    const rows = new Map([bot("Earlier reply."), { ...first, parentId: "m-earlier" }, folded, reply].map((row) => [row.id, row]));
    rows.set("m-earlier", { ...bot("Earlier reply."), id: "m-earlier" });
    const opening = answeredRows(reply, (id) => rows.get(id));
    expect(opening.map((row) => row.text)).toEqual([first.text, folded.text]);
    expect(turnLeftovers([...opening, reply])).toEqual([{ ask: first.text }, { ask: folded.text, held: true }]);
    expect(answeredRows(undefined, (id) => rows.get(id))).toEqual([]);
  });

  it("keeps a question the quick helper handed into the turn as a steer", () => {
    expect(turnLeftovers([user("What font is it?"), user("And the ramp color?", { steered: true, quick: { state: "handoff" } }), bot("The ramp color is blue, like the toolbar.")])).toEqual([{ ask: "What font is it?" }, { ask: "And the ramp color?", held: true }]);
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
    expect(next).toContain(`- A1 open promise unchecked ${DAY}: I'll run the data export in the background. (Export running as PID 4128, leave it alone.)`);
    expect(next).toContain("running processes first");
    expect(next).toContain("never start one twice");
    // a running line about other work is no note
    expect(turnLeftovers([user("go on"), bot("I'll update the picker labels."), bot("The backup is running.")])).toEqual([promise("I'll update the picker labels.")]);
  });

  it("gives every promise of a narrated turn its own ID; a list shows the first three and the rest by ID, in under 2 ms", () => {
    const rows = [user("Do the release"), ...Array.from({ length: 60 }, (_, i) => [bot(`I'll check step ${i} of the release notes.`), tool("RELEASE-NOTES.md"), bot(`Step ${i} is fine.`)]).flat(), bot(`All done. ${"More detail on the release. ".repeat(150)}`)];
    expect(turnLeftovers(rows)).toHaveLength(60);
    const saved = fileLeftovers(undefined, turnLeftovers(rows), 9)!;
    expect(saved.asks.map((item) => [item.id, item.ask, item.ref])).toEqual(Array.from({ length: 60 }, (_, i) => [`A${i + 1}`, `I'll check step ${i} of the release notes.`, undefined]));
    const more = `- +57 more unchecked promises, each open by ID; a status question lists them: ${Array.from({ length: 57 }, (_, i) => `A${i + 4}`).join(", ")}`;
    for (const list of [asksBlock(saved.asks, 10), asksNudge(saved.asks, 10, "ok")]) {
      expect(list.split("\n").slice(1)).toEqual([0, 1, 2].map((i) => `- A${i + 1} open promise unchecked ${DAY}: I'll check step ${i} of the release notes.`).concat(more));
    }
    expect(asksBlock(saved.asks, 10, true)).toContain(`- A60 open promise unchecked ${DAY}: I'll check step 59 of the release notes.`);
    const started = performance.now();
    for (let i = 0; i < 20; i++) fileLeftovers(undefined, turnLeftovers(rows), 9);
    expect((performance.now() - started) / 20).toBeLessThan(2);
  });

  it("keeps each of four promises addressable: past three closed by ID, the fourth still lists (2226G cap)", () => {
    const four = turnLeftovers([user("Please handle the release follow-ups"), tool(), bot("I'll update the guide. I'll check the invoice. I'll review the font. I'll email the release calendar.")]);
    const saved = fileLeftovers(undefined, four, 5)!;
    expect(saved.asks.map((item) => [item.id, item.ask, item.ref])).toEqual([
      ["A1", "I'll update the guide.", undefined],
      ["A2", "I'll check the invoice.", undefined],
      ["A3", "I'll review the font.", undefined],
      ["A4", "I'll email the release calendar.", undefined],
    ]);
    expect(asksBlock(saved.asks, 6)).toContain("- +1 more unchecked promises, each open by ID; a status question lists them: A4");
    const closed = saved.asks.map((item) => item.id === "A4" ? item : { ...item, status: "done" as const });
    for (const list of [asksBlock(closed, 7), asksBlock(closed, 7, true), asksNudge(closed, 7, "status?")]) expect(list).toContain(`- A4 open promise unchecked ${DAY}: I'll email the release calendar.`);
  });

  it("knows a repeat by its full words, past the clip, and a path by its case (2226G identity)", () => {
    const long = promise("I'll update the keyboard shortcuts documentation for the desktop color picker and the settings page.");
    const first = fileLeftovers(undefined, [long], 5)!;
    expect(first.asks[0]!.ask).toMatch(/…$/);
    expect(fileLeftovers(first, [long], 9)).toBeNull();
    expect(fileLeftovers({ asks: first.asks.map((item) => ({ ...item, status: "done" as const })), lastAskId: 1 }, [long], 9)).toBeNull();
    const headers = fileLeftovers(undefined, turnLeftovers([user("Please address the two headers"), tool(), bot("I'll update the file src/Header.ts. I'll update the file src/header.ts.")]), 5)!;
    expect(headers.asks.map((item) => [item.id, item.ask])).toEqual([["A1", "I'll update the file src/Header.ts."], ["A2", "I'll update the file src/header.ts."]]);
    // ordinary words still match whatever their case
    expect(fileLeftovers(headers, [promise("I'll Update the File src/Header.ts")], 9)).toBeNull();
  });

  it("keeps the check on a carried question on every list until an engine settles it by ID (2226G three switches)", () => {
    let filed = fileLeftovers(undefined, turnLeftovers([user("Could you write ready.txt?"), bot("Back soon.")]), 5)!.asks;
    for (const at of [6, 7, 8]) {
      const list = asksBlock(filed, at);
      expect(list).toContain("check the transcript, files and running processes first");
      expect(list).toContain(`- A1 open unchecked ${DAY}: Could you write ready.txt?`);
      filed = filed.map((item) => ({ ...item, shown: at }));
    }
    expect(asksNudge(filed, 9, "did you write ready.txt")).toContain("never start one twice");
    expect(asksBlock(filed.map((item) => ({ ...item, status: "building" as const })), 9)).not.toMatch(/unchecked/);
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
    expect(next).toContain(`- A1 open promise unchecked ${DAY}: I'll update the picker labels.`);
    expect(next).toContain(`- A2 open unchecked ${DAY}: Where are the keyboard shortcuts documented?`);
    expect(asksNudge(saved.asks.map((item) => ({ ...item, shown: 6 })), 7, "ok")).toBe("");
    // a fresh engine's full list marks an open promise unchecked and says to close it by ID, not redo it
    expect(asksBlock(saved.asks, 6)).toContain("close each by ID or set it building with the job's ref through update_task_state; never start one twice.");
    expect(asksBlock([{ ...saved.asks[0]!, status: "building", ref: "PID 4128" }], 6)).toContain(`- A1 building promise ${DAY}: I'll update the picker labels. (PID 4128)`);
    // a carried question alone gets the same check on a fresh engine's full list
    const invoice = fileLeftovers(undefined, [{ ask: "Could you email the invoice?" }], 5)!.asks;
    expect(asksBlock(invoice, 6)).toContain("An unchecked row may be done or running already: check the transcript, files and running processes first");
    expect(asksBlock(invoice, 6)).toContain(`- A1 open unchecked ${DAY}: Could you email the invoice?`);
  });

  it("keeps a long question's mark and never nags a question or promise to be built", () => {
    const question = "Where are the keyboard shortcuts for the color picker documented, and can I change them from the settings page?";
    const filed = settle([user(question), user("Color?", { steered: true }), bot("Blue.")], []);
    expect(filed[0]).toMatchObject({ id: "A1", status: "open" });
    expect(filed[0]!.ask).toHaveLength(80);
    expect(filed[0]!.ask.endsWith("?")).toBe(true);
    const late = 9 + ASK_VERDICT_MS;
    for (const nudge of [asksNudge(filed, late, "Thanks"), asksNudge([{ ...ask("A1", "Where are the keyboard shortcuts documented?", "open"), key: "a".repeat(64) }, ask("A2", "I'll update the picker labels.", "open", "promise")], late, "Thanks")]) expect(nudge).not.toMatch(/build, park or close|needs? (a )?verdict/);
  });
});
