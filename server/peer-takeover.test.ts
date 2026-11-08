import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hasPeerWatch, peerAnswer, peerInputJoined, takePeerReplyStamp, watchPeerTurn } from "./peer-takeover.ts";
import type { Message } from "./store.ts";

function ask(threadId: string) {
  const answers: string[] = [];
  const answer = peerAnswer(threadId, "Wink", () => "Edward", (text) => answers.push(text));
  return { answer, answers };
}

describe("ask_bot takeover", () => {
  it.each(["A real answer", "(timed out waiting for the bot to reply)"])("reports a real text reply without inspecting its wording: %s", (text) => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-signal", "Wink", () => "Edward", (out, replied) => answers.push({ text: out, replied }));
    answer.add(text);
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text, replied: true }]);
  });

  it.each([
    ["timeout", "(timed out waiting for the bot to reply)"],
    ["no text", "(the bot finished without a text reply)"],
    ["start failure", "(couldn't start that bot: unavailable)"],
  ])("does not report a reply after %s", (outcome, fallback) => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-no-reply", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.end(fallback, outcome === "no text");
    expect(answers).toEqual([{ text: fallback, replied: false }]);
  });

  it("does not report a timed-out partial answer as a reply", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-partial", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.add("Partial answer");
    answer.end("(timed out waiting for the bot to reply)", false);
    expect(answers).toEqual([{ text: "Partial answer", replied: false }]);
  });

  it("keeps the ask and pane-note hold live through a marked user reply", () => {
    const { answer, answers } = ask("t-user-split");
    answer.add("<user1>Edward, 1.0.157 is out.</user1>");
    expect(answers).toEqual([]);
    expect(hasPeerWatch("t-user-split")).toBe(true);
    answer.add("The build is green.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual(["The build is green."]);
    expect(hasPeerWatch("t-user-split")).toBe(false);
  });

  it("answers the asker with only the text from before a pane note joined", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-ask-note", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    answer.add("Got the note.");
    peerInputJoined("t-ask-note");
    answer.add("The eval questions are ready.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text: "Got the note.", replied: true }]);
  });

  it("does not report a reply when a pane note joined before any text", () => {
    const answers: Array<{ text: string; replied: boolean }> = [];
    const answer = peerAnswer("t-ask-note-empty", "Wink", () => "Edward", (text, replied) => answers.push({ text, replied }));
    peerInputJoined("t-ask-note-empty");
    answer.add("The eval questions are ready.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual([{ text: "Wink took in a worker's note before answering. Ask again later.", replied: false }]);
    expect(hasPeerWatch("t-ask-note-empty")).toBe(false);
  });

  it("keeps the whole reply when nobody cuts in", () => {
    const { answer, answers } = ask("t-ask-3");
    answer.add("First.");
    answer.add("Second.");
    answer.end("(the bot finished without a text reply)");
    expect(answers).toEqual(["First.\nSecond."]);
    expect(hasPeerWatch("t-ask-3")).toBe(false);
  });
});

describe("peer turn registry", () => {
  it("keeps other watches when one collector releases", () => {
    const end = watchPeerTurn("t-reg");
    const { answer } = ask("t-reg");
    answer.end("could not start", false);
    expect(hasPeerWatch("t-reg")).toBe(true);
    end();
    expect(hasPeerWatch("t-reg")).toBe(false);
  });

  it("tells every watch a pane note joined without releasing the hold", () => {
    let joined = 0;
    const end = watchPeerTurn("t-note", () => joined++);
    peerInputJoined("t-note");
    peerInputJoined("other");
    expect(joined).toBe(1);
    expect(hasPeerWatch("t-note")).toBe(true);
    end();
    expect(hasPeerWatch("t-note")).toBe(false);
  });

  it("wires user input separately from pane-note delivery", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const botChat = readFileSync(new URL("./bot-chat-routes.ts", import.meta.url), "utf8");
    expect(index).not.toContain("takeOverPeerTurn");
    expect(botChat).toContain("peerInput = beginPeerUserReply(bot.id, threadId, prompt);");
    expect(botChat).toContain("peerInput?.accept(message);");
    expect(botChat).toContain("peerTurn: hasPeerWatch(threadId)");
    expect(index).toContain("holds: hasPeerWatch,");
  });
});

describe("peer reply stamp", () => {
  const comm: NonNullable<Message["comm"]> = { groupId: "pair", withBotId: "atlas", withName: "Atlas", withColor: "pink" };
  const pending = () => new Map<string, NonNullable<Message["comm"]>>([["t-stamp", { ...comm }]]);

  it("stamps the first shown text while the watch is live, copied as is", () => {
    const end = watchPeerTurn("t-stamp");
    try {
      const stamped = takePeerReplyStamp(pending(), "t-stamp", { text: "Two bullets were reworded." });
      expect(stamped).toEqual(comm);
      expect(stamped).not.toHaveProperty("peer");
    } finally {
      end();
    }
  });

  it.each([
    ["summarized", { text: "An engine summary.", summarized: true }],
    ["blank", { text: "  \n " }],
    ["missing", {}],
  ])("skips a %s row", (_kind, message) => {
    const end = watchPeerTurn("t-stamp");
    try {
      expect(takePeerReplyStamp(pending(), "t-stamp", message)).toBeUndefined();
    } finally {
      end();
    }
  });

  it("skips an ordinary turn with no pending comm", () => {
    const end = watchPeerTurn("t-stamp");
    try {
      expect(takePeerReplyStamp(new Map(), "t-stamp", { text: "Hello." })).toBeUndefined();
    } finally {
      end();
    }
  });

  it("stamps once per turn", () => {
    const end = watchPeerTurn("t-stamp");
    try {
      const live = pending();
      expect(takePeerReplyStamp(live, "t-stamp", { text: "First." })).toEqual(comm);
      expect(takePeerReplyStamp(live, "t-stamp", { text: "Second." })).toBeUndefined();
    } finally {
      end();
    }
  });

  it("stays bare once the peer turn ends", () => {
    const end = watchPeerTurn("t-stamp");
    end();
    expect(takePeerReplyStamp(pending(), "t-stamp", { text: "Late text." })).toBeUndefined();
  });

  it("index.ts keeps the pending comm per thread and clears it on settle and on stamp", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/peerReplyComm\.set\(threadId, opts\??\.peerComm\)/);
    expect(index).toMatch(/peerReplyComm\.delete\(event\.threadId\)/);
    expect(index).toMatch(/takePeerReplyStamp\(peerReplyComm, event\.threadId/);
  });
});
