import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { createQuietTurns } from "./quiet-turn.ts";
import { Store } from "./store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  // a stopped, disowned or settled turn's late output is nobody's reply");
const gate = source.slice(start, source.indexOf("\n  event = stripStrayUserTags(event);", start));
const shownByIndex = new Function(ts.transpileModule(`return function run(scope) { with (scope) { ${gate}\n return true; } }`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
}).outputText)() as (scope: object) => boolean | undefined;

describe("quiet turns", () => {
  let store: Store;
  let threadId: string;
  let quietTurnText: ReturnType<typeof createQuietTurns>;
  let chat: string[];

  beforeEach(() => {
    store = new Store(() => ({ instanceId: "fake", model: "fake" }));
    threadId = store.createBot().threadId;
    quietTurnText = createQuietTurns((id) => store.messagesFor(id));
    chat = [];
  });

  const publish = (patch: Record<string, unknown>, turnId = "t1") => {
    const event = { provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId, turnId, ...patch } as RuntimeEvent;
    if (!shownByIndex({ event, staleTurnEvent: () => false, quietTurnText })) return;
    if (event.type === "content.delta") chat.push(`delta:${event.delta}`);
    if (event.type === "item.completed" && event.itemType === "assistant_text") chat.push(event.text);
  };
  const tool = (title: string, turnId?: string) => publish({ type: "item.started", itemType: "tool", itemId: crypto.randomUUID(), title }, turnId);
  const text = (value: string, turnId?: string) => {
    publish({ type: "content.delta", streamKind: "assistant_text", delta: value }, turnId);
    publish({ type: "item.completed", itemType: "assistant_text", text: value }, turnId);
  };
  const wake = () => {
    store.appendMessage(threadId, { role: "bot", kind: "note", text: "Live Verify checked SIDE-PANEL.md: 1 problem." });
    publish({ type: "turn.started" });
  };

  it("hides text a woken turn writes after no_reply_needed", () => {
    wake();
    tool("mcp__agents__no_reply_needed");
    text("Already answered: `no_reply_needed` was called.");
    publish({ type: "turn.completed", ok: true });
    expect(chat).toEqual([]);
  });

  it("keeps the text when the user wrote during the turn", () => {
    wake();
    tool("mcp__agents__no_reply_needed");
    store.appendMessage(threadId, { role: "user", kind: "text", text: "are you there?", steered: true });
    text("Yes, here.");
    expect(chat).toEqual(["delta:Yes, here.", "Yes, here."]);
  });

  it("keeps the reply to the message that started the turn", () => {
    store.appendMessage(threadId, { role: "user", kind: "text", text: "status?" });
    publish({ type: "turn.started" });
    tool("no_reply_needed");
    text("All green.");
    expect(chat).toEqual(["delta:All green.", "All green."]);
  });

  it("keeps text written before the call and in the next turn", () => {
    wake();
    text("Merged.");
    tool("no_reply_needed");
    text("Nothing else.");
    publish({ type: "turn.completed", ok: true });
    wake();
    text("CI failed.");
    expect(chat).toEqual(["delta:Merged.", "Merged.", "delta:CI failed.", "CI failed."]);
  });

  it("matches only the agents tool, not a command quoting it", () => {
    wake();
    tool('grep -n "no_reply_needed" server/index.ts');
    text("Found it.");
    tool("agents/no_reply_needed");
    text("Slip.");
    expect(chat).toEqual(["delta:Found it.", "Found it."]);
  });
});
