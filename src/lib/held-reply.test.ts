import { describe, expect, it } from "vitest";

import { holdsReply } from "./held-reply";
import type { Message } from "@/state/store";

const user: Message = { id: "u1", at: 1, role: "user", kind: "text", text: "fix the parser test" };
const step: Message = { id: "b1", at: 2, role: "bot", kind: "text", text: "Running the tests again." };

describe("holdsReply", () => {
  it("holds a live turn's plain text for the turn's end", () => {
    expect(holdsReply(step, true, [user])).toBe(true);
    expect(holdsReply({ ...step, id: "b2" }, true, [user, step])).toBe(true);
  });

  it("plays text outside a live turn at once", () => {
    expect(holdsReply(step, false, [user])).toBe(false);
  });

  it("plays a steer reply, a sidekick answer, a peer line and a summary at once", () => {
    const steer: Message = { id: "u2", at: 3, role: "user", kind: "text", text: "also check CI", steered: true };
    expect(holdsReply({ ...step, id: "b2" }, true, [user, step, steer])).toBe(false);
    expect(holdsReply({ ...step, quick: { state: "answer", askId: "a1" } }, true, [user])).toBe(false);
    expect(holdsReply({ ...step, comm: { groupId: "g1", withBotId: "rosa", withName: "Rosa", withColor: "coral", peer: "reply" } }, true, [user])).toBe(false);
    expect(holdsReply({ ...step, summarized: true }, true, [user])).toBe(false);
  });

  it("plays a peer turn's text at once", () => {
    const inbound: Message = { id: "u1", at: 1, role: "user", kind: "text", text: "Check the release.", from: { botId: "atlas", name: "Atlas", color: "pink" } };
    expect(holdsReply(step, true, [inbound])).toBe(false);
  });

  it("holds the text after a queued send, which starts its own turn", () => {
    const queued: Message = { id: "u2", at: 3, role: "user", kind: "text", text: "next", steered: true, queueId: "q1" };
    expect(holdsReply({ ...step, id: "b2" }, true, [user, step, queued])).toBe(true);
  });
});
