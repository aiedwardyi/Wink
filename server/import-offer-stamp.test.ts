// The offer turn's reply row is stamped through index.ts's own item.completed and turn.completed handling, sliced out of the source.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "./config.ts";
import { noteOfferTurn, takeImportOffer } from "./memory-import-offer.ts";
import { applySyncedRows, closeMessageDb, readThread } from "./message-db.ts";
import { takePeerReplyStamp } from "./peer-takeover.ts";
import { persistPeerUserReply } from "./peer-user-reply.ts";
import type { Message } from "./store.ts";
import { ThreadSyncV2 } from "./thread-sync-v2.ts";
import { isVoiceLine } from "../shared/live-call.ts";
import { catalogs } from "../src/lib/i18n-catalog.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function required<T>(node: T | undefined, label: string): T {
  if (!node) throw new Error(`import-offer-stamp: could not locate ${label} in index.ts; update the selector`);
  return node;
}
const fold = required(find(parsed, (node) => ts.isSwitchStatement(node)
  && node.expression.getText(parsed) === "event.type"
  && node.getText(parsed).includes("const settledReply = lastReply.get(event.threadId)")) as ts.SwitchStatement | undefined, "event.type switch");
const clause = (type: string) => required(fold.caseBlock.clauses.find((node) => ts.isCaseClause(node) && node.expression.getText(parsed) === `"${type}"`), `${type} case`);
const textRow = clause("item.completed");
const noteEnd = required(find(clause("turn.completed"), (node) => ts.isExpressionStatement(node) && node.getText(parsed).startsWith("noteOfferTurn(")), "noteOfferTurn on turn.completed");

function run(body: string, deps: Record<string, unknown>) {
  const javascript = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `{${javascript}}`)(...Object.values(deps));
}

function chat() {
  const messages: Message[] = [];
  const deps: Record<string, unknown> = {
    takePeerReplyStamp, isVoiceLine, persistPeerUserReply, noteOfferTurn, takeImportOffer,
    peerReplyComm: new Map(), lastReply: new Map(), markChatLatency: () => {},
    turnSummary: { note: () => {} },
    store: { findLast: (_: string, predicate: (message: Message) => boolean) => messages.findLast(predicate) },
    pushMessage: (message: Omit<Message, "id" | "at">) => {
      const row = { id: `m${messages.length}`, at: 1, ...message } as Message;
      messages.push(row);
      return row;
    },
  };
  return {
    messages,
    say(text: string, summarized = false) {
      const event = { type: "item.completed", itemType: "assistant_text", threadId: "t1", turnId: "u1", provider: "claude", text, summarized };
      run(`switch (event.type) { ${textRow.getText(parsed)} }`, { ...deps, event });
    },
    done() {
      run(noteEnd.getText(parsed), { ...deps, event: { type: "turn.completed", threadId: "t1" } });
    },
  };
}

const prompts = { en: catalogs.en["aboutYou.prompt"], ko: catalogs.ko["aboutYou.prompt"] };
const reply = (prompt: string) => `Hi!\n\nWant me to know what ChatGPT already knows?\n\n\`\`\`text\n${prompt}\n\`\`\``;
const stamped = (rows: Message[]) => rows.map((row) => row.importOffer === true);

afterEach(() => noteOfferTurn("t1", false));

describe("the offer reply row", () => {
  it.each(["en", "ko"] as const)("is stamped on the offer turn's %s reply, once", (locale) => {
    const c = chat();
    noteOfferTurn("t1", true);
    c.say("Checking first.");
    c.say(reply(prompts[locale]));
    c.say(reply(prompts[locale]));
    expect(stamped(c.messages)).toEqual([false, true, false]);
    c.done();
  });

  it.each(["en", "ko"] as const)("is not stamped when a bot echoes the %s prompt on an ordinary turn", (locale) => {
    const c = chat();
    noteOfferTurn("t1", false);
    c.say(reply(prompts[locale]));
    expect(stamped(c.messages)).toEqual([false]);
  });

  it("is not stamped on an offer turn that never showed the prompt, nor on a later turn once it ends", () => {
    const c = chat();
    noteOfferTurn("t1", true);
    c.say("Hello, how can I help?");
    c.say(reply(prompts.en), true);
    c.done();
    c.say(reply(prompts.en));
    expect(stamped(c.messages)).toEqual([false, false, false]);
  });

  it("is never stamped in a thread whose turn did not offer, such as a room", () => {
    const c = chat();
    noteOfferTurn("room", true);
    c.say(reply(prompts.en));
    expect(stamped(c.messages)).toEqual([false]);
  });

  it("is marked at the turn start from the same offer decision the model's note comes from", () => {
    expect(source).toMatch(/const importMemory = [^;]+;\s*noteOfferTurn\(threadId, importMemory\.offer\);/);
  });
});

describe("the stamp travels", () => {
  const roots: string[] = [];
  const clients: ThreadSyncV2[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = () => {
    const root = mkdtempSync(join(tmpdir(), "offer-stamp-"));
    roots.push(root);
    return root;
  };
  const scope = { botSyncId: "bot", threadId: "offer-thread" };

  it("survives a restart and reaches a second PC's store", async () => {
    const row: Message = { id: "offer", role: "bot", kind: "text", at: 1, parentId: null, text: reply(prompts.ko), importOffer: true };
    const folder = temp();
    const pc = (deviceId: string) => {
      const client = new ThreadSyncV2({ folder, dataDir: temp(), deviceId, headBytes: 4096 });
      clients.push(client);
      return client;
    };
    const a = pc("a");
    const b = pc("b");
    ensureDirs();
    applySyncedRows("offer-restart", [row], "row");
    closeMessageDb();
    expect(readThread("offer-restart", join(temp(), "missing.json")).messages).toEqual([row]);

    await a.commit(scope, [{ kind: "row", value: row }]);
    await a.flush(scope);
    await b.pull(scope);
    const received = (await b.scan(scope.threadId)).messages;
    expect(received).toEqual([row]);
    applySyncedRows("offer-peer", received, "row");
    closeMessageDb();
    expect(readThread("offer-peer", join(temp(), "missing.json")).messages[0].importOffer).toBe(true);
  });
});
