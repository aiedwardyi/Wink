// A driver's turn through index.ts's own row and reply bookkeeping, sliced
// out of the source, then the chat's shown filter.
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isShownMessage } from "../src/lib/shown-message.ts";
import { ensureDirs } from "./config.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { takePeerReplyStamp, watchPeerTurn } from "./peer-takeover.ts";
import { persistPeerUserReply } from "./peer-user-reply.ts";
import { ENGINE_SUMMARY_PREFIX } from "./replies.ts";
import type { Message } from "./store.ts";
import { recordEvents } from "./testing/events.ts";
import { ownTurnReply, turnSummaries } from "./turn-reply.ts";

const testing = join(dirname(fileURLToPath(import.meta.url)), "testing");
const FAKE_CODEX = join(testing, "fake-codex-app-server.ts");
const FAKE_CLAUDE = join(testing, "fake-claude-cli.ts");

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}

function compile(body: string, deps: Record<string, unknown>) {
  const javascript = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `{${javascript}}`)(...Object.values(deps));
}

function required<T>(node: T | undefined, label: string): T {
  if (!node) throw new Error(`codex-commentary: could not locate ${label} in index.ts; update the selector`);
  return node;
}

const ledger = required(parsed.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === "turnSummary")), "turnSummary declaration");
const fold = required(find(parsed, (node) => ts.isSwitchStatement(node)
  && node.expression.getText(parsed) === "event.type"
  && node.getText(parsed).includes("const settledReply = lastReply.get(event.threadId)")) as ts.SwitchStatement | undefined, "event.type switch");
const clause = (type: string) => required(fold.caseBlock.clauses.find((node) => ts.isCaseClause(node) && node.expression.getText(parsed) === `"${type}"`), `${type} case`);
const textRow = clause("item.completed");
const settle = required(find(clause("turn.completed"), (node) => ts.isForOfStatement(node) && node.getText(parsed).includes("turnSummary.settle")), "turnSummary.settle loop");
const roomTurn = required(parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "runClaimedGroupMemberTurn"), "runClaimedGroupMemberTurn");
const roomStep = required(find(roomTurn, (node) => ts.isIfStatement(node) && node.expression.getText(parsed) === 'step === "completed"'), "room reply step");

const isText = (e: RuntimeEvent): e is Extract<RuntimeEvent, { itemType: "assistant_text" }> =>
  e.type === "item.completed" && e.itemType === "assistant_text";

function chat(threadId: string) {
  const messages: Message[] = [];
  const patches: Array<Partial<Message>> = [];
  const peerReplyComm = new Map<string, NonNullable<Message["comm"]>>();
  const deps: Record<string, unknown> = {
    turnSummaries, takePeerReplyStamp, persistPeerUserReply, peerReplyComm, lastReply: new Map(), markChatLatency: () => {}, paneNoteTurnThreads: new Set<string>(),
    store: {
      messagesFor: () => messages,
      patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => {
        patches.push(patch);
        Object.assign(messages.find((message) => message.id === id)!, patch);
      },
    },
    pushMessage: (message: Omit<Message, "id" | "at">) => {
      const row = { id: `message-${messages.length}`, at: 1, ...message } as Message;
      messages.push(row);
      return row;
    },
  };
  deps.turnSummary = compile(`${ledger.getText(parsed)}\nreturn turnSummary;`, deps);
  return {
    messages,
    patches,
    peerReplyComm,
    feed(event: RuntimeEvent) {
      if (event.threadId !== threadId) return;
      if (isText(event)) compile(`switch (event.type) { ${textRow.getText(parsed)} }`, { ...deps, event });
      if (event.type === "turn.completed") compile(settle.getText(parsed), { ...deps, event });
    },
    shown: () => messages.filter((message) => message.kind === "text" && isShownMessage(message)).map((message) => message.text),
  };
}

describe("a turn's commentary after its final answer", () => {
  let instance: ProviderInstance | undefined;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CODEX, 0o755);
    chmodSync(FAKE_CLAUDE, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MESSAGES;
    delete process.env.FAKE_CLAUDE_MODE;
    await instance?.dispose();
    instance = undefined;
  });

  const run = async (threadId: string) => {
    const recorder = recordEvents(instance!.adapter);
    await instance!.adapter.sendTurn({ threadId, text: "that's a lot of bugs, right?" });
    await recorder.until((e) => e.type === "turn.completed");
    recorder.stop();
    return recorder.events;
  };
  const codexTurn = async (threadId: string, messages: Array<{ text: string; phase: string }>) => {
    process.env.FAKE_CODEX_MESSAGES = JSON.stringify(messages);
    instance = await CodexDriver.create({ instanceId: "codex-test", displayName: "Codex", environment: {}, enabled: true, config: { cli: FAKE_CODEX, fullAuto: false } });
    return run(threadId);
  };
  const commentary = "Several incidents may share one cause; I'll check what remains.";
  const final = "13 review entries do not mean 13 bugs.";

  it("shows commentary live, then only the final answer once the turn completes", async () => {
    const events = await codexTurn("t-final", [{ text: commentary, phase: "commentary" }, { text: final, phase: "final_answer" }]);
    const view = chat("t-final");
    for (const event of events.filter((e) => e.type !== "turn.completed")) view.feed(event);
    expect(view.shown()).toEqual([commentary, final]);
    view.feed(events.find((e) => e.type === "turn.completed")!);
    expect(view.shown()).toEqual([final]);
  });

  it("keeps a commentary-only turn's rows", async () => {
    const events = await codexTurn("t-commentary", [{ text: commentary, phase: "commentary" }, { text: "Still checking.", phase: "commentary" }]);
    expect(events.filter(isText).map((e) => e.phase)).toEqual(["commentary", "commentary"]);
    const view = chat("t-commentary");
    for (const event of events) view.feed(event);
    expect(view.shown()).toEqual([commentary, "Still checking."]);
    expect(view.patches).toEqual([]);
  });

  it("keeps the one-line answer to a steered message after the final answer", async () => {
    const recorded = JSON.parse(readFileSync(new URL("../test/fixtures/recorded/codex/steer-reply-commentary.json", import.meta.url), "utf8"));
    const items: Array<{ text: string; phase: string }> = recorded.reply.events.map((event: { params: { item: { text: string; phase: string } } }) => event.params.item);
    expect(items.map((item) => item.phase)).toEqual(["commentary", "commentary", "final_answer"]);
    for (const [threadId, queueId, shown] of [["t-steer", undefined, [recorded.stamp.steer, items[1].text, items[2].text]], ["t-folded", "queue-1", [recorded.stamp.steer, items[2].text]]] as const) {
      const events = await codexTurn(threadId, items);
      const view = chat(threadId);
      const [first, ...rest] = events.filter(isText);
      view.feed(first);
      const steered: Message = { id: "user-b", at: 1, role: "user", kind: "text", text: recorded.stamp.steer, steered: true };
      if (queueId) steered.queueId = queueId;
      view.messages.push(steered);
      for (const event of rest) view.feed(event);
      view.feed(events.find((e) => e.type === "turn.completed")!);
      expect(view.shown(), threadId).toEqual(shown);
      await instance?.dispose();
      instance = undefined;
    }
  });

  it("hides the next turn's commentary after a steer that got no reply", async () => {
    const events = await codexTurn("t-stale", [{ text: commentary, phase: "commentary" }, { text: final, phase: "final_answer" }]);
    const view = chat("t-stale");
    view.messages.push({ id: "user-b", at: 1, role: "user", kind: "text", text: "also check the logs", steered: true }, { id: "user-c", at: 2, role: "user", kind: "text", text: "next question" });
    for (const event of events) view.feed(event);
    expect(view.shown()).toEqual(["also check the logs", "next question", final]);
  });

  it("gives a peer turn's Reply-to stamp to the final, not the hidden commentary", async () => {
    const events = await codexTurn("t-peer", [{ text: commentary, phase: "commentary" }, { text: final, phase: "final_answer" }]);
    const view = chat("t-peer");
    const comm = { groupId: "peer-room", withBotId: "caller", withName: "Caller", withColor: "blue", peer: "reply" } as const;
    view.peerReplyComm.set("t-peer", comm);
    const unwatch = watchPeerTurn("t-peer");
    for (const event of events) view.feed(event);
    unwatch();
    expect(view.messages.map((message) => message.comm)).toEqual([undefined, comm]);
  });

  it("folds a room reply to the final answer", async () => {
    const events = await codexTurn("t-room", [{ text: commentary, phase: "commentary" }, { text: final, phase: "final_answer" }]);
    const reply = ownTurnReply(() => false);
    const deadline = { setWaitingOnHuman: () => {} };
    let replyText = "";
    for (const e of events) {
      replyText = compile(`${roomStep.getText(parsed)}\nreturn replyText;`, { e, step: reply.fold(e), finish: () => {}, deadline, replyText });
    }
    expect(replyText).toBe(`\n${final}`);
  });

  it("keeps partial answers in chat and the room reply after the final answer", async () => {
    const partial = "@Reviewer, check the first finding.";
    const events = await codexTurn("t-partial", [
      { text: commentary, phase: "commentary" },
      { text: partial, phase: "partial_answer" },
      { text: "Still checking.", phase: "commentary" },
      { text: final, phase: "final_answer" },
    ]);
    const view = chat("t-partial");
    const reply = ownTurnReply(() => false);
    const deadline = { setWaitingOnHuman: () => {} };
    let replyText = "";
    for (const e of events) {
      view.feed(e);
      replyText = compile(`${roomStep.getText(parsed)}\nreturn replyText;`, { e, step: reply.fold(e), finish: () => {}, deadline, replyText });
    }
    expect(view.shown()).toEqual([partial, final]);
    expect(replyText).toBe(`\n${partial}\n${final}`);
  });

  it("leaves Claude's narration events, rows and reply as they were", async () => {
    process.env.FAKE_CLAUDE_MODE = "narration-only";
    instance = await ClaudeDriver.create({ instanceId: "claude-test", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } });
    const events = await run("t-claude");
    const texts = events.filter(isText);
    expect(texts.map(({ text, summarized }) => ({ text, summarized }))).toEqual([{ text: "only a summary", summarized: true }, { text: "final answer" }]);
    expect(texts.some((e) => "phase" in e)).toBe(false);
    const view = chat("t-claude");
    for (const event of events) view.feed(event);
    expect(view.shown()).toEqual(["final answer"]);
    expect(view.patches).toEqual([]);
    const reply = ownTurnReply(() => false);
    expect(events.map((event) => reply.fold(event)).filter(Boolean)).toEqual([
      { text: `${ENGINE_SUMMARY_PREFIX}only a summary` },
      { text: "final answer" },
      "completed",
    ]);
  });
});
