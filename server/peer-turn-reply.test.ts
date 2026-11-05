import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { peerTurnReplies } from "./peer-turn-reply.ts";

type Phase = "commentary" | "partial_answer" | "final_answer";

function rig(staleTurns: string[] = []) {
  const replies = peerTurnReplies((_threadId, turnId) => Boolean(turnId && staleTurns.includes(turnId)));
  const event = (threadId: string, turnId: string | undefined, patch: Record<string, unknown>) => replies.observe({
    provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId, turnId, ...patch,
  } as RuntimeEvent);
  const text = (threadId: string, turnId: string, body: string, phase?: Phase, summarized?: boolean) =>
    event(threadId, turnId, { type: "item.completed", itemType: "assistant_text", text: body, phase, summarized });
  const tool = (threadId: string, turnId: string) => event(threadId, turnId, { type: "item.completed", itemType: "tool", itemId: "call-1" });
  const started = (threadId: string, turnId: string) => event(threadId, turnId, { type: "turn.started" });
  const completed = (threadId: string, turnId: string | undefined, ok = true) => event(threadId, turnId, { type: "turn.completed", ok });
  return { replies, text, tool, started, completed };
}

describe("peerTurnReplies", () => {
  it("keeps every text item of the turn, not only the last", () => {
    const r = rig();
    const wink = r.replies.start("wink");
    r.started("wink", "t1");
    r.text("wink", "t1", "Yes, the ko check runs in the release gate.");
    r.tool("wink", "t1");
    r.text("wink", "t1", "Done.");
    r.completed("wink", "t1");
    expect(wink.text()).toBe("Yes, the ko check runs in the release gate.\nDone.");
  });

  it("gives only the final answer once one arrives after commentary", () => {
    const r = rig();
    const codex = r.replies.start("codex");
    r.text("codex", "t1", "Checking the release gate.", "commentary");
    r.text("codex", "t1", "The ko check runs in the release gate.", "final_answer");
    r.text("codex", "t1", "Late commentary.", "commentary");
    expect(codex.text()).toBe("The ko check runs in the release gate.");
  });

  it("keeps partial, unphased and later final items while dropping commentary", () => {
    const r = rig();
    const reply = r.replies.start("wink");
    r.text("wink", "t1", "Checking.", "commentary");
    r.text("wink", "t1", "First finding.", "partial_answer");
    r.text("wink", "t1", "Context.");
    r.text("wink", "t1", "Still checking.", "commentary");
    r.text("wink", "t1", "Second finding.", "final_answer");
    r.text("wink", "t1", "Third finding.", "final_answer");
    expect(reply.text()).toBe("First finding.\nContext.\nSecond finding.\nThird finding.");
  });

  it("leaves engine summaries out, so a summary-only turn wrote nothing", () => {
    const r = rig();
    const only = r.replies.start("a");
    r.started("a", "t1");
    r.text("a", "t1", "Checked the logs.", undefined, true);
    r.tool("a", "t1");
    r.completed("a", "t1");
    expect(only.text()).toBeUndefined();
    const mixed = r.replies.start("b");
    r.text("b", "t2", "Checked the logs.", undefined, true);
    r.text("b", "t2", "All clear.");
    expect(mixed.text()).toBe("All clear.");
  });

  it("keeps two threads and their turns apart, and ignores stale or other-turn text", () => {
    const r = rig(["stopped"]);
    const wink = r.replies.start("wink");
    const atlas = r.replies.start("atlas");
    r.text("wink", "stopped", "late text of a stopped turn");
    r.started("wink", "w1");
    r.started("atlas", "a1");
    r.text("atlas", "a1", "Atlas answer.");
    r.text("wink", "w1", "Wink answer.");
    r.text("wink", "other", "not this turn");
    r.completed("wink", "other");
    r.text("wink", "w1", "Wink more.");
    r.completed("atlas", "a1");
    r.completed("atlas", "a1");
    r.text("atlas", "a1", "after the end");
    expect(wink.text()).toBe("Wink answer.\nWink more.");
    expect(atlas.text()).toBe("Atlas answer.");
  });

  it("stops at its turn's completion and when released, keeping the text readable", () => {
    const r = rig();
    const first = r.replies.start("wink");
    r.text("wink", "t1", "Edward, DOG has one card left.");
    first.release();
    r.text("wink", "t1", "more for Edward");
    expect(first.text()).toBe("Edward, DOG has one card left.");
    expect(r.replies._live()).toBe(0);

    const rerun = r.replies.start("wink");
    r.completed("wink", "t1");
    r.started("wink", "t2");
    r.text("wink", "t2", "Yes, the ko check runs in the release gate.");
    r.completed("wink", "t2");
    r.text("wink", "t2", "after the end");
    expect(rerun.text()).toBe("Yes, the ko check runs in the release gate.");
    rerun.release();
    expect(r.replies._live()).toBe(0);
  });

  it("lets only its own handle release a thread's collection", () => {
    const r = rig();
    const failed = r.replies.start("wink");
    const next = r.replies.start("wink");
    failed.release();
    expect(r.replies._live()).toBe(1);
    r.text("wink", "t2", "next turn's answer");
    expect(failed.text()).toBeUndefined();
    expect(next.text()).toBe("next turn's answer");
    next.release();
    expect(r.replies._live()).toBe(0);
  });

  it("keeps a handoff's collection when a competing ask on its thread never starts", () => {
    const r = rig();
    const handoff = r.replies.start("wink");
    const ask = r.replies.start("wink");
    ask.release();
    r.started("wink", "t1");
    r.text("wink", "t1", "Yes, the ko check runs in the release gate.");
    r.completed("wink", "t1");
    expect(handoff.text()).toBe("Yes, the ko check runs in the release gate.");
    expect(ask.text()).toBeUndefined();
    expect(r.replies._live()).toBe(0);
  });
});
