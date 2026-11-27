import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as roots from "./comms-root.ts";
import { DATA_DIR } from "./config.ts";
import { _resetPending, pendingDelegationSnapshot } from "./delegations.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";
import { removeTestData } from "./testing/test-home.ts";

let store: Store;
let from: ReturnType<Store["createBot"]>;
let reader: ReturnType<Store["createBot"]>;

beforeEach(() => {
  removeTestData(DATA_DIR);
  _resetPending();
  roots._resetCommsRoots();
  store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  from = store.createBot();
  reader = store.createBot();
  turnRegistry.start("turn", { botId: from.id, threadId: from.threadId, owner: "user", depth: 0, rootId: roots.rootForStart(from.threadId, { kind: "human", messageKey: "send-1" }) });
});
afterEach(() => {
  turnRegistry.settle("turn");
  _resetPending();
});

async function ask(extra: Record<string, unknown>) {
  const askBotAndWait = vi.fn(async (_to: string, _message: string, _depth: number, _from?: string, peer?: { reservation?: roots.Reservation }) => {
    if (peer?.reservation) roots.commit(peer.reservation);
    return { replied: true, text: "page text" };
  });
  const route = createInternalRoutes({ store, commsBus: { store, broadcast: () => {} }, approvalBus: { store, broadcast: () => {} }, MAX_COMMS_DEPTH: 1,
    MAX_WORKSPACE_BOTS: 100, checkedMemberIds: (memberIds: string[]) => ({ ok: true, memberIds }),
    connectorThread: (botId: string, threadId: string) => store.conversationForBot(botId, threadId),
    delegationWatch: new Map(), askBotAndWait, readOnlyTurn: () => false,
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
  let body = "";
  const res = { writeHead() {}, getHeader() {}, setHeader() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  const pending = route.askBot(req, res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: reader.id, message: "read https://example.com/", ...extra }));
  req.emit("end");
  await pending;
  return { reply: JSON.parse(body) as Record<string, unknown>, askBotAndWait };
}

describe("web_read's borrowed reader", () => {
  it("asks the reader as a reader turn, and an ordinary ask as before", async () => {
    const asked = await ask({ reader: true });
    expect(asked.reply).toMatchObject({ text: "page text", replied: true });
    expect(asked.askBotAndWait.mock.calls[0]![4]).toMatchObject({ reader: true });
    const plain = await ask({});
    expect(plain.askBotAndWait.mock.calls[0]![4]).not.toHaveProperty("reader");
  });

  it("is never queued, since a queued ask runs as a normal turn", async () => {
    store.bot(reader.id)!.busy = true;
    const asked = await ask({ reader: true });
    expect(asked.reply).toEqual({ busy: true });
    expect(asked.askBotAndWait).not.toHaveBeenCalled();
    expect(pendingDelegationSnapshot()).toEqual([]);
  });

  it("runs read-only", () => {
    const proxy = readFileSync(new URL("./drivers/agents-proxy.ts", import.meta.url), "utf8");
    expect(proxy).toContain("body: JSON.stringify({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, toBotId, message, depth: DEPTH, reader: true }) }), READ_ONLY);");
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("...(peer?.reader ? { webReader: true } : {}),");
    expect(index).toContain("const readOnly = opts?.readOnly === true || opts?.webReader === true;");
  });
});
