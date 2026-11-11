import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { watchPeerTurn } from "./peer-takeover.ts";
import { _resetPeerUserReplies, beginPeerUserReply, peerUserRuntime, persistPeerUserReply, stripStrayUserTags } from "./peer-user-reply.ts";
import { Store } from "./store.ts";

describe("stray user tags", () => {
  let store: Store;
  let botId: string;
  let threadId: string;

  beforeEach(() => {
    _resetPeerUserReplies();
    store = new Store(() => ({ instanceId: "fake", model: "fake" }));
    const bot = store.createBot();
    botId = bot.id;
    threadId = bot.threadId;
  });
  afterEach(() => _resetPeerUserReplies());

  const event = (patch: Record<string, unknown>): RuntimeEvent => ({
    provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId, turnId: "t1", ...patch,
  } as RuntimeEvent);
  const delta = (text: string) => event({ type: "content.delta", streamKind: "assistant_text", delta: text });
  const done = (text: string) => event({ type: "item.completed", itemType: "assistant_text", text });
  const shown = (e: RuntimeEvent) => (e.type === "content.delta" ? e.delta : "");

  it("unwraps a tag split across deltas without flashing a fragment", () => {
    const sent = ["<", "us", "er1>Got", " it</us", "er1>", " Done <u"].map((piece) => shown(stripStrayUserTags(delta(piece))));
    expect(sent).toEqual(["", "", "Got", " it", "", " Done "]);
    expect(sent.join("")).not.toMatch(/<\/?u/);
  });

  it("releases a held fragment that turns out to be text", () => {
    expect(["a <", "b"].map((piece) => shown(stripStrayUserTags(delta(piece)))).join("")).toBe("a <b");
  });

  it("keeps code literal while streaming", () => {
    const sent = ["```\n<user", "1>x</user1>\n```\n<user2>ok</user2>"].map((piece) => shown(stripStrayUserTags(delta(piece))));
    expect(sent.join("")).toBe("```\n<user1>x</user1>\n```\nok");
  });

  it("unwraps the completed and stored text", () => {
    const clean = stripStrayUserTags(done("<user1>Got it</user1>"));
    expect(clean).toMatchObject({ text: "Got it" });
    if (clean.type !== "item.completed" || clean.itemType !== "assistant_text") throw new Error("not text");
    expect(persistPeerUserReply(store, clean)).toBe(false);
    const row = store.appendMessage(threadId, { role: "bot", kind: "text", text: clean.text });
    expect(row.text).toBe("Got it");
    expect(stripStrayUserTags(done("```\n<user1>x</user1>\n```"))).toMatchObject({ text: "```\n<user1>x</user1>\n```" });
  });

  it("keeps the current turn's held fragment through an old turn's late boundary", () => {
    const at = (turnId: string, patch: Record<string, unknown>) => event({ turnId, ...patch });
    stripStrayUserTags(at("t2", { type: "turn.started" }));
    expect(shown(stripStrayUserTags(at("t2", { type: "content.delta", streamKind: "assistant_text", delta: "<us" })))).toBe("");
    stripStrayUserTags(at("t1", { type: "turn.completed", ok: true }));
    expect(shown(stripStrayUserTags(at("t2", { type: "content.delta", streamKind: "assistant_text", delta: "er1>new</user1>" })))).toBe("new");
  });

  it("passes tag-free text through and switches on when a tag appears", () => {
    const sent = ["Plain ", "text <", "b>", " then <us", "er1>Hi</user1> end"].map((piece) => shown(stripStrayUserTags(delta(piece))));
    expect(sent).toEqual(["Plain ", "text ", "<b>", " then ", "Hi end"]);
  });

  it("streams 25k small deltas in linear time", () => {
    stripStrayUserTags(delta("<user1>"));
    const start = performance.now();
    let sent = "";
    for (let at = 0; at < 25_000; at++) sent += shown(stripStrayUserTags(delta("abcd")));
    expect(performance.now() - start).toBeLessThan(500);
    expect(sent).toBe("abcd".repeat(25_000));
  });

  it("starts each item's stream fresh", () => {
    stripStrayUserTags(delta("<user1>one"));
    stripStrayUserTags(done("one"));
    expect(shown(stripStrayUserTags(delta("<user2>two</user2>")))).toBe("two");
  });

  it("leaves a peer turn's split exactly as it was", () => {
    const end = watchPeerTurn(threadId);
    peerUserRuntime(event({ type: "turn.started" }));
    const input = beginPeerUserReply(botId, threadId, "Question?")!;
    const tag = input.prompt.match(/<user\d+>/)![0];
    const reply = done(`${tag}main${tag.replace("<", "</")}\nPeer answer.`);
    expect(stripStrayUserTags(reply)).toBe(reply);
    expect(stripStrayUserTags(delta("<us"))).toMatchObject({ delta: "<us" });
    expect(peerUserRuntime(stripStrayUserTags(reply))).toMatchObject({ text: "main" });
    end();
  });

  it("tells the bot the wrapper is for this reply only", () => {
    const end = watchPeerTurn(threadId);
    expect(beginPeerUserReply(botId, threadId, "Q")!.prompt).toMatch(/for this reply only/i);
    end();
  });
});
