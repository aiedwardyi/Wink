import { describe, expect, it } from "vitest";

import type { Message } from "./store.ts";
import { asksBlock, fileLeftovers, type TaskAsk } from "./task-asks.ts";
import { turnLeftovers } from "./turn-leftovers.ts";

let n = 0;
const user = (text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, role: "user", kind: "text", text, at: n, ...extra });
const bot = (text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, role: "bot", kind: "text", text, at: n, ...extra });
const tool = (summary = ""): Message => ({ id: `m${++n}`, role: "bot", kind: "activity", tool: { name: "Read", ok: true, summary }, at: n });
const ask = (id: string, text: string, status: TaskAsk["status"], kind?: TaskAsk["kind"]): TaskAsk => {
  const filed: TaskAsk = { id, ask: text, status, at: 1, changedAt: 1 };
  if (kind) filed.kind = kind;
  return filed;
};

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
    expect(turnLeftovers([user("Ship it"), tool(), bot("Shipped. I'll watch CI tomorrow.")])).toEqual([]);
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
    const saved = fileLeftovers(book, [{ ask: "I'll renumber the labels.", promise: true }], 9)!;
    expect(saved.asks.slice(0, 4)).toEqual(open);
    expect(saved.asks.at(-1)).toMatchObject({ id: "A5", status: "open", kind: "promise" });
  });

  it("settles a long narrated turn in under 2 ms", () => {
    const rows = [user("Do the release"), ...Array.from({ length: 60 }, (_, i) => [bot(`I'll check step ${i} of the release notes.`), tool("RELEASE-NOTES.md"), bot(`Step ${i} is fine.`)]).flat(), bot(`All done. ${"More detail on the release. ".repeat(150)}`)];
    expect(turnLeftovers(rows)).toEqual([]);
    const started = performance.now();
    for (let i = 0; i < 20; i++) turnLeftovers(rows);
    expect((performance.now() - started) / 20).toBeLessThan(2);
  });
});
