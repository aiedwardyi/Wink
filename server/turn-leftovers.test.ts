import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { ASK_VERDICT_MS, asksBlock, asksNudge, fileLeftovers, type TaskAsk } from "./task-asks.ts";
import { settledAsks, turnLeftovers } from "./turn-leftovers.ts";

let n = 0;
const user = (text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, role: "user", kind: "text", text, at: n, ...extra });
const bot = (text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, role: "bot", kind: "text", text, at: n, ...extra });
const tool = (summary = "", ok = true): Message => ({ id: `m${++n}`, role: "bot", kind: "activity", tool: { name: "Read", ok, summary }, at: n });
const ask = (id: string, text: string, status: TaskAsk["status"], kind?: TaskAsk["kind"]): TaskAsk => {
  const filed: TaskAsk = { id, ask: text, status, at: 1, changedAt: 1 };
  if (kind) filed.kind = kind;
  return filed;
};
// one settled turn: what it closed, narrowed and left open
const settle = (rows: Message[], asks: TaskAsk[]) => fileLeftovers({ asks, lastAskId: asks.length }, turnLeftovers(rows), 9, settledAsks(rows, asks))?.asks ?? asks;

describe("turn leftovers", () => {
  it("files the promises Codex's hidden notes made and its final never took up, and the question a steer talked over merges into one", () => {
    const left = turnLeftovers([
      user("How does Wink keep my work when I switch models? Also keep the picker changes moving."),
      bot("I'll answer the model-switch question from how Wink actually stores chats and tasks.", { summarized: true }),
      bot("I'll keep the picker changes moving.", { summarized: true }),
      user("What color should the ramp be?", { steered: true }),
      bot("Blue."),
    ]);
    expect(left).toEqual([
      { ask: "I'll answer the model-switch question from how Wink actually stores chats and tasks.", promise: true },
      { ask: "I'll keep the picker changes moving.", promise: true },
      { ask: "How does Wink keep my work when I switch models?" },
    ]);
    const saved = fileLeftovers(undefined, left, 5)!;
    expect(saved.asks.map((item) => [item.id, item.kind])).toEqual([["A1", "promise"], ["A2", "promise"]]);
    expect(saved.asks[0]!.ask).toHaveLength(80);
    expect(asksBlock(saved.asks, 5)).toContain("- A2 open promise 01-01: I'll keep the picker changes moving.");
  });

  it("files nothing for in-turn work the turn reported, an offer, a promise in the last text or a question the user saw answered", () => {
    expect(turnLeftovers([user("Check the logs"), bot("I'll check the logs first."), tool(), bot("Logs are clean.")])).toEqual([]);
    // the call it made after saying so took it up
    expect(turnLeftovers([user("Release?"), bot("I'll read the release notes."), tool("RELEASE-NOTES.md"), bot("Step 3 is fine."), bot("Ready.")])).toEqual([]);
    expect(turnLeftovers([user("Tests?"), bot("If you want, I'll add tests for the parser."), tool(), bot("Done.")])).toEqual([]);
    expect(turnLeftovers([user("Ship it"), tool(), bot("Shipped. I'll keep an eye on it.")])).toEqual([]);
    // a reply the user saw under the question, then a steer
    expect(turnLeftovers([user("What font is it?"), bot("Inter."), user("And the size?", { steered: true }), bot("14 px.")])).toEqual([]);
    // the final took the earlier question up
    expect(turnLeftovers([user("What font is it?"), user("And the size?", { steered: true }), bot("The font is Inter at 14 px.")])).toEqual([]);
  });

  it("never files twice, never reopens a done or declined ask, and merges into the user's matching ask", () => {
    const open = [ask("A1", "I'll keep the picker changes moving.", "open", "promise"), ask("A2", "Pick the ramp color", "open"), ask("A3", "Add 60 fps clips", "done"), ask("A4", "Rename the release branch", "declined")];
    const book = { asks: open, lastAskId: 4 };
    expect(fileLeftovers(book, [{ ask: "I'll keep the picker changes moving.", promise: true }], 9)).toBeNull();
    expect(fileLeftovers(book, [{ ask: "What color should the ramp be?" }], 9)).toBeNull();
    expect(fileLeftovers(book, [{ ask: "I'll add the 60 fps clips.", promise: true }], 9)).toBeNull();
    expect(fileLeftovers(book, [{ ask: "I'll rename the release branch.", promise: true }], 9)).toBeNull();
    // distinct promises sharing an action and place both file
    expect(fileLeftovers(undefined, [{ ask: "I'll update the desktop icon.", promise: true }, { ask: "I'll update the desktop layout.", promise: true }], 9)?.asks).toHaveLength(2);
    const saved = fileLeftovers(book, [{ ask: "I'll renumber the labels.", promise: true }], 9)!;
    expect(saved.asks.slice(0, 4)).toEqual(open);
    expect(saved.asks.at(-1)).toMatchObject({ id: "A5", status: "open", kind: "promise" });
  });

  it("keeps a short subject and a promise that only mentions if or want", () => {
    const promises = ["I'll fix the API.", "I'll check if the backup exists.", "I'll implement the feature you want."];
    expect(turnLeftovers([user("Keep going."), ...promises.map((line) => bot(line, { summarized: true })), user("Color?", { steered: true }), bot("Blue.")])).toEqual(promises.map((ask) => ({ ask, promise: true })));
    expect(turnLeftovers([user("Status?"), bot("I'll fix the API."), tool(), bot("The API is fixed.")])).toEqual([]);
  });

  it("keeps a question of short words a steer talked over", () => {
    expect(turnLeftovers([user("Why is CI red?"), user("Color?", { steered: true }), bot("Blue.")])).toEqual([{ ask: "Why is CI red?" }]);
    expect(turnLeftovers([user("Why is CI red?"), user("Color?", { steered: true }), bot("Blue. CI is red from a flaky test.")])).toEqual([]);
  });

  it("keeps a question the quick helper handed into the turn as a steer", () => {
    expect(turnLeftovers([user("What font is it?"), user("And the ramp color?", { steered: true, quick: { state: "handoff" } }), bot("Blue.")])).toEqual([{ ask: "What font is it?" }]);
  });

  it("never refiles a closed promise or a short question and keeps asks a word apart distinct", () => {
    const api = { asks: [ask("A1", "I'll fix the API", "done", "promise")], lastAskId: 1 };
    expect(fileLeftovers(api, [{ ask: "I'll fix the API", promise: true }], 9)).toBeNull();
    expect(fileLeftovers(api, [{ ask: "I'll fix the API.", promise: true }], 9)).toBeNull();
    for (const status of ["open", "done", "declined"] as const) expect(fileLeftovers({ asks: [ask("A1", "Why is CI red?", status)], lastAskId: 1 }, [{ ask: "Why is CI red?" }], 9)).toBeNull();
    expect(fileLeftovers(undefined, [{ ask: "I'll update the desktop toolbar icon.", promise: true }, { ask: "I'll update the desktop toolbar layout.", promise: true }], 9)?.asks).toHaveLength(2);
  });

  it("keeps the part of a promise the turn did not finish, and a job it reported running files as running", () => {
    expect(turnLeftovers([user("Picker?"), bot("I'll rebuild the picker."), tool(), bot("I couldn't rebuild the picker.")])).toEqual([{ ask: "I'll rebuild the picker.", promise: true }]);
    const running = turnLeftovers([user("Export the data"), bot("I'll run the data export in the background."), tool("export.ps1"), bot("Export running as PID 4128, leave it alone.")]);
    expect(running).toEqual([{ ask: "I'll run the data export in the background.", promise: true, running: "Export running as PID 4128" }]);
    const saved = fileLeftovers(undefined, running, 5)!;
    expect(saved.asks[0]).toMatchObject({ status: "building", kind: "promise", ref: "Export running as PID 4128" });
    const block = asksBlock(saved.asks, 5 + ASK_VERDICT_MS);
    expect(block).toContain("- A1 building promise 01-01: I'll run the data export in the background. (Export running as PID 4128)");
    expect(block).toContain("never start it again");
    // an old promise never asks to be built
    expect(asksBlock([ask("A1", "I'll update the picker labels.", "open", "promise")], 1 + ASK_VERDICT_MS)).not.toMatch(/needs? (a )?verdict|build, park or close/);
  });

  it("keeps the second question a reply skipped and a final reply's promise on a time", () => {
    expect(turnLeftovers([user("What color should the ramp be? Where are the keyboard shortcuts documented?"), bot("The ramp should be blue.")])).toEqual([{ ask: "Where are the keyboard shortcuts documented?" }]);
    expect(turnLeftovers([user("Invoice?"), tool(), bot("I'll review the invoice tomorrow.")])).toEqual([{ ask: "I'll review the invoice tomorrow.", promise: true }]);
    // one question the reply took up its own way, and a final "I'll" with no time, stay off the list
    expect(turnLeftovers([user("What font is it?"), bot("Inter.")])).toEqual([]);
    expect(turnLeftovers([user("Fix it"), tool(), bot("Fixed. I'll keep it simple.")])).toEqual([]);
    // a take-back drops the promise it names, or a bare one the promise right before it; a hedged one drops nothing
    expect(turnLeftovers([user("Report?"), bot("I'll send the report tomorrow. Actually, scratch that.")])).toEqual([]);
    expect(turnLeftovers([user("Report?"), bot("I'll send the report tomorrow. I'll email Bob tonight. Cancel that report.")])).toEqual([{ ask: "I'll email Bob tonight.", promise: true }]);
    expect(turnLeftovers([user("Report?"), bot("I'll send the report tomorrow. Cancel that if we have to.")])).toEqual([{ ask: "I'll send the report tomorrow.", promise: true }]);
  });

  it("shows a newly filed item on the next turn once, resumed or not", () => {
    const saved = fileLeftovers(undefined, [{ ask: "I'll update the picker labels.", promise: true }], 5)!;
    expect(asksNudge(saved.asks, 6, "ok")).toContain("- A1 open promise 01-01: I'll update the picker labels.");
    expect(asksNudge(saved.asks.map((item) => ({ ...item, shown: 6 })), 7, "ok")).toBe("");
  });

  it("closes a carried promise the next turn reports done and a question it answered, and only those", () => {
    const open = [ask("A1", "I'll update the picker labels.", "open", "promise"), ask("A2", "Where are the keyboard shortcuts documented?", "open"), ask("A3", "I'll update the icon and layout.", "open", "promise"), ask("A4", "Pick the ramp color", "open")];
    expect(settledAsks([user("go on"), bot("The keyboard shortcuts are in GUIDE.md. I updated the picker labels.")], open)).toEqual([{ id: "A1" }, { id: "A2" }]);
    // a failure, a repeat, an instruction and the user's own ask close nothing
    for (const reply of ["I couldn't update the picker labels.", "I'll update the picker labels.", "Please update the picker labels.", "The ramp color is blue."]) expect(settledAsks([user("go on"), bot(reply)], open)).toEqual([]);
    const saved = fileLeftovers({ asks: open, lastAskId: 4 }, [{ ask: "I'll update the picker labels.", promise: true }], 9, [{ id: "A1" }, { id: "A2" }])!;
    expect(saved.asks.map((item) => item.status)).toEqual(["done", "done", "open", "open"]);
  });

  it("settles a long narrated turn in under 2 ms", () => {
    const rows = [user("Do the release"), ...Array.from({ length: 60 }, (_, i) => [bot(`I'll check step ${i} of the release notes.`), tool("RELEASE-NOTES.md"), bot(`Step ${i} is fine.`)]).flat(), bot(`All done. ${"More detail on the release. ".repeat(150)}`)];
    expect(turnLeftovers(rows)).toEqual([]);
    const started = performance.now();
    for (let i = 0; i < 20; i++) turnLeftovers(rows);
    expect((performance.now() - started) / 20).toBeLessThan(2);
  });

  it("marks an existing promise the turn reports running as building with its line, so the next reply checks on it", () => {
    const filed = [{ ...ask("A1", "I'll run the data export in the background.", "open", "promise"), shown: 5 }];
    const after = settle([user("Export the data"), bot("I'll run the data export in the background."), tool("export.ps1"), bot("Export running as PID 4128, leave it alone.")], filed);
    expect(after).toEqual([expect.objectContaining({ id: "A1", status: "building", ref: "Export running as PID 4128" })]);
    const next = asksNudge(after, 10, "ok");
    expect(next).toContain("- A1 building promise 01-01: I'll run the data export in the background. (Export running as PID 4128)");
    expect(next).toContain("never start it again");
  });

  it("closes nothing on an acknowledgment, a request, a still-needs or a failure, and closes what a line says is done", () => {
    const open = [ask("A1", "Where are the keyboard shortcuts documented?", "open"), ask("A2", "I'll read the release notes.", "open", "promise"), ask("A3", "I'll set the backup schedule.", "open", "promise"), ask("A4", "I'll fix the picker labels.", "open", "promise")];
    for (const reply of ["The keyboard shortcuts are a good question. I'll get back to you.", "I'm checking where the keyboard shortcuts are documented.", "Please read the release notes.", "Please set the backup schedule.", "The picker labels still need to be fixed.", "I couldn't read the release notes."]) {
      expect(settle([user("go on"), bot(reply)], open).map((item) => item.status)).toEqual(["open", "open", "open", "open"]);
    }
    expect(settle([user("go on"), bot("I read the release notes. I set the backup schedule. The picker labels are fixed.")], open).map((item) => item.status)).toEqual(["open", "done", "done", "done"]);
    // in the turn that promised it
    const read = { ask: "I'll read the release notes.", promise: true };
    expect(turnLeftovers([user("Release?"), bot("I'll read the release notes."), tool("RELEASE-NOTES.md", false), bot("I couldn't read the release notes.")])).toEqual([read]);
    expect(turnLeftovers([user("Release?"), bot("I'll read the release notes."), bot("Please read the release notes.")])).toEqual([read]);
    expect(turnLeftovers([user("Picker?"), bot("I'll fix the picker labels."), tool(), bot("The picker labels still need to be fixed.")])).toEqual([{ ask: "I'll fix the picker labels.", promise: true }]);
  });

  it("keeps the main desktop toolbar layout apart from its icon, open or done, a promise or the user's ask", () => {
    const layout = { ask: "I'll update the main desktop toolbar layout.", promise: true as const };
    for (const status of ["open", "done"] as const) {
      expect(fileLeftovers({ asks: [ask("A1", "I'll update the main desktop toolbar icon.", status, "promise")], lastAskId: 1 }, [layout], 9)?.asks).toHaveLength(2);
      expect(fileLeftovers({ asks: [ask("A1", "Update the main desktop toolbar icon", status)], lastAskId: 1 }, [layout], 9)?.asks).toHaveLength(2);
    }
    expect(fileLeftovers(undefined, [{ ask: "I'll update the main desktop toolbar icon.", promise: true }, layout], 9)?.asks).toHaveLength(2);
  });

  it("narrows a half-done promise to what is left and closes it once that is done", () => {
    expect(turnLeftovers([user("Polish the toolbar"), bot("I'll update the icon and layout."), tool(), bot("The icon is updated.")])).toEqual([{ ask: "I'll update the layout.", promise: true }]);
    const half = settle([user("go on"), bot("The icon is updated.")], [ask("A1", "I'll update the icon and layout.", "open", "promise")]);
    expect(half).toEqual([expect.objectContaining({ id: "A1", status: "open", ask: "I'll update the layout." })]);
    expect(settle([user("go on"), bot("The layout is updated.")], half)[0]).toMatchObject({ id: "A1", status: "done" });
  });

  it("closes a long question its exact answer takes up, and never nags a question or promise to be built", () => {
    const question = "Where are the keyboard shortcuts for the color picker documented, and can I change them from the settings page?";
    const filed = settle([user(question), user("Color?", { steered: true }), bot("Blue.")], []);
    expect(filed).toEqual([expect.objectContaining({ id: "A1", status: "open" })]);
    expect(filed[0]!.ask).toHaveLength(80);
    const late = 9 + ASK_VERDICT_MS;
    for (const nudge of [asksNudge(filed, late, "Thanks"), asksNudge([ask("A1", "Where are the keyboard shortcuts documented?", "open"), ask("A2", "I'll update the picker labels.", "open", "promise")], late, "Thanks")]) expect(nudge).not.toMatch(/build, park or close|needs? (a )?verdict/);
    const answered = settle([user("go on"), bot("The keyboard shortcuts for the color picker are documented in GUIDE.md, and you can change them from the settings page.")], filed);
    expect(answered[0]).toMatchObject({ id: "A1", status: "done" });
  });
});
