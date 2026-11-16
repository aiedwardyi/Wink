import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { ownTurnReply, turnSummaries } from "./turn-reply.ts";

function rig(staleTurns: string[]) {
  const bus = new EventBus(() => {});
  const stale = (_threadId: string, turnId: string | undefined) => Boolean(turnId && staleTurns.includes(turnId));
  const shown: string[] = [];
  bus.subscribe((e) => {
    if (stale(e.threadId, e.turnId)) return;
    if (e.type === "item.completed" && e.itemType === "assistant_text") shown.push(e.text);
  });
  const reply = ownTurnReply(stale);
  let text = "";
  let completed = false;
  bus.subscribe((e) => {
    const step = reply.fold(e);
    if (step === "completed") completed = true;
    else if (step) text = step.replace ? step.text : text + (text ? "\n" : "") + step.text;
  });
  const event = (turnId: string, patch: Record<string, unknown>) => bus.publish({
    provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId: "t1", turnId, ...patch,
  } as RuntimeEvent);
  return { reply, event, shown, text: () => text, completed: () => completed };
}

describe("ownTurnReply", () => {
  it("drops a stopped turn's late text and completion", () => {
    const r = rig(["stopped"]);
    r.event("current", { type: "turn.started" });
    r.event("stopped", { type: "item.completed", itemType: "assistant_text", text: "obsolete answer" });
    r.event("stopped", { type: "turn.completed", ok: false });
    expect(r.completed()).toBe(false);
    r.event("current", { type: "item.completed", itemType: "assistant_text", text: "current answer" });
    r.event("current", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("current answer");
    expect(r.completed()).toBe(true);
    expect(r.shown).toEqual(["current answer"]);
  });

  it("ignores another live turn once it owns one", () => {
    const r = rig([]);
    r.reply.claim("mine");
    r.event("other", { type: "item.completed", itemType: "assistant_text", text: "not mine" });
    r.event("other", { type: "turn.completed", ok: true });
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "mine" });
    expect(r.completed()).toBe(false);
    r.event("mine", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("mine");
    expect(r.completed()).toBe(true);
  });

  it("reports a claimed turn that completed before the claim", () => {
    const r = rig(["failed"]);
    r.event("failed", { type: "turn.started" });
    r.event("failed", { type: "turn.completed", ok: false });
    expect(r.completed()).toBe(false);
    expect(r.reply.claim("failed")).toBe(true);
  });

  it("marks an engine summary in the collected reply", () => {
    const r = rig([]);
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "Checking the logs.", summarized: true });
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "All clear." });
    r.event("mine", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("[Engine summary of a mid-turn note, not shown to the user; the exact words were not kept] Checking the logs.\nAll clear.");
  });

  it("adopts its turn from the first fresh text", () => {
    const r = rig([]);
    r.event("mine", { type: "item.completed", itemType: "assistant_text", text: "mine" });
    r.event("other", { type: "item.completed", itemType: "assistant_text", text: "not mine" });
    r.event("mine", { type: "turn.completed", ok: true });
    expect(r.text()).toBe("mine");
    expect(r.completed()).toBe(true);
  });

  it("keeps partial and subsequent answers while removing only commentary", () => {
    const r = rig([]);
    const text = (body: string, phase?: "commentary" | "partial_answer" | "final_answer") =>
      r.event("mine", { type: "item.completed", itemType: "assistant_text", text: body, phase });
    text("Checking.", "commentary");
    text("First finding.", "partial_answer");
    text("Context.");
    text("Still checking.", "commentary");
    text("Second finding.", "final_answer");
    text("Late commentary.", "commentary");
    text("Third finding.", "final_answer");
    expect(r.text()).toBe("First finding.\nContext.\nSecond finding.\nThird finding.");
  });
});

describe("turnSummaries", () => {
  it("shows a turn's summaries when it wrote no other text", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "turn-1", "s1", true);
    summaries.note("t1", "turn-1", "s2", true);
    expect(summaries.settle("t1", "turn-1")).toEqual(["s1", "s2"]);
    expect(summaries.settle("t1", "turn-1")).toEqual([]);
  });

  it("keeps summaries hidden once the turn wrote plain text", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "turn-1", "s1", true);
    summaries.note("t1", "turn-1", "r1", false);
    summaries.note("t1", "turn-1", "s2", true);
    expect(summaries.settle("t1", "turn-1")).toEqual([]);
  });

  it("keeps a quiet turn's summaries hidden", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "turn-1", "s1", true);
    expect(summaries.settle("t1", "turn-1", true)).toEqual([]);
    summaries.note("t1", "turn-2", "s2", true);
    expect(summaries.settle("t1", "turn-2")).toEqual(["s2"]);
  });

  it("never lets an older turn's completion settle the next turn", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "old", "r0", false);
    summaries.note("t1", "new", "s1", true);
    expect(summaries.settle("t1", "old")).toEqual([]);
    expect(summaries.settle("t1", "new")).toEqual(["s1"]);
  });

  it("keeps threads apart", () => {
    const summaries = turnSummaries();
    summaries.note("t1", "a", "s1", true);
    summaries.note("t2", "b", "r1", false);
    expect(summaries.settle("t2", "b")).toEqual([]);
    expect(summaries.settle("t1", "a")).toEqual(["s1"]);
  });

  const answer = "The build passed on all three PCs and the release notes are in the docs folder.";
  const settled = (texts: Array<string | undefined>) => {
    const hidden: string[] = [];
    const summaries = turnSummaries((_threadId, ids, restated) => hidden.push(...ids.map((id) => (restated ? id : `commentary:${id}`))));
    texts.forEach((text, i) => summaries.note("t1", "turn-1", `r${i}`, false, undefined, text));
    summaries.settle("t1", "turn-1");
    return hidden;
  };

  it("hides a text the turn later restates", () => {
    expect(settled([answer, `Build passed on all three PCs, and the release notes are in the docs folder. ${"Your one question is in your box."}`])).toEqual(["r0"]);
    expect(settled([answer, answer, answer])).toEqual(["r0", "r1"]);
  });

  it("keeps an answer followed by a short or different line", () => {
    expect(settled([answer, "Saved."])).toEqual([]);
    expect(settled([answer, "Next I'll check the phone build and the release on work tomorrow."])).toEqual([]);
    expect(settled(["Checking the logs.", "Checking the logs."])).toEqual([]);
  });

  it("hides a restated commentary row once, as restated", () => {
    const hidden: Array<[string[], true | undefined]> = [];
    const summaries = turnSummaries((_threadId, ids, restated) => hidden.push([ids, restated]));
    summaries.note("t1", "turn-1", "c0", false, "commentary", answer);
    summaries.note("t1", "turn-1", "c1", false, "commentary", "Checking the logs.");
    summaries.note("t1", "turn-1", "f0", false, "final_answer", answer);
    summaries.settle("t1", "turn-1");
    expect(hidden).toEqual([[["c1"], undefined], [["c0"], true]]);
  });

  it("counts only content words", () => {
    expect(settled(["Done, I moved the old notes into the archive for you.", "Done. I think the old plan is all for you, and it is still on the list, into next week."])).toEqual([]);
  });

  it("keeps a line whose words a long answer only holds far apart", () => {
    const later = "**Not quite.** Most of the eval did run, and two results are real. What's missing is the rival race. - **Token use:** Wink uses more tokens than last week, so a worker is cutting it now. - **Deadline:** the fix lands Friday before the next phone release, then the eval reruns overnight on the home PC. - **Cards:** the ADEMark card and the memory card are written and waiting for your pick.";
    expect(settled(["Now the token worker deadline, then the eval and ADEMark cards.", later])).toEqual([]);
  });

  const long = "The build passed on all three PCs, the release notes are in the docs folder, and the phone build ships tomorrow morning after the nightly run.";
  const ask = `${long} Your one question is in your box.`;

  it("keeps an earlier text with a link the later one lacks", () => {
    expect(settled([`${long} See https://wink.dev/notes.`, ask])).toEqual([]);
    expect(settled([`${long} See https://wink.dev/notes.`, `${ask} https://wink.dev/notes`])).toEqual(["r0"]);
  });

  it("keeps an earlier text with a path the later one lacks", () => {
    expect(settled([`${long} Notes: D:\\wink\\docs\\notes.md`, ask])).toEqual([]);
  });

  it("keeps an earlier text with an image the later one lacks", () => {
    expect(settled([`${long} ![chart](/api/attachments/chart.png)`, ask])).toEqual([]);
  });

  it("keeps an earlier text with a code block the later one lacks", () => {
    expect(settled([`${long}\n\`\`\`\npnpm test\n\`\`\``, ask])).toEqual([]);
  });

  it("keeps an earlier text with a number the later one lacks", () => {
    expect(settled([`${long} It took 14 minutes.`, ask])).toEqual([]);
    expect(settled([`${long} It took 14 minutes.`, `${ask} Took 14 minutes.`])).toEqual(["r0"]);
  });

  it("keeps a row noted without text", () => {
    expect(settled([undefined, answer])).toEqual([]);
    expect(settled([answer, undefined])).toEqual([]);
  });
});
