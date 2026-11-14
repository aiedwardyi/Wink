import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createGroupRoutes } from "./group-routes.ts";
import { Store, type BotRecord, type GroupRecord } from "./store.ts";

const index = ts.createSourceFile("index.ts", readFileSync(join(import.meta.dirname, "index.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);

/** A top-level function of index.ts, built against `deps`. */
function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  const code = ts.transpileModule(node!.getText(index), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `${code}\nreturn ${name};`)(...Object.values(deps));
}

let store: Store;
let kai: BotRecord;
let ray: BotRecord;
let zed: BotRecord;
let group: GroupRecord;
let interruptTurn: ReturnType<typeof vi.fn>;
let releaseInterruptedBot: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  [kai, ray, zed] = [store.createBot(), store.createBot(), store.createBot()];
  group = store.createGroup("Launch", [kai.id, ray.id]);
  store.patchGroup(group.id, { busyBotId: kai.id });
  interruptTurn = vi.fn(async () => {});
  releaseInterruptedBot = vi.fn((botId: string) => {
    if (store.group(group.id)?.busyBotId === botId) store.patchGroup(group.id, { busyBotId: null });
  });
});

async function patch(body: object) {
  const routes = createGroupRoutes({
    store,
    groupIsWorking: (value: GroupRecord) => Boolean(value.busyBotId),
    publicGroupState: (value: GroupRecord) => value,
    checkedGroupResponder: (value: unknown) => value,
    checkedMemberIds: (value: string[]) => ({ ok: true, memberIds: value }),
    registry: { get: () => ({ adapter: { interruptTurn } }) },
    bumpTurnEpoch: () => 1,
    markThreadInterrupted: vi.fn(),
    flushInterruptedTask: vi.fn(),
    closeOpenApprovals: vi.fn(),
    releaseInterruptedBot,
  } as unknown as Parameters<typeof createGroupRoutes>[0]);
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await routes.patch(Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
  return { status: res.writeHead.mock.calls[0][0] as number, body: JSON.parse(res.end.mock.calls[0][0]) };
}

describe("a group's roster while a member is answering", () => {
  it("adds a bot and leaves the running turn alone", async () => {
    expect((await patch({ memberIds: [kai.id, ray.id, zed.id] })).status).toBe(200);
    expect(store.group(group.id)).toMatchObject({ memberIds: [kai.id, ray.id, zed.id], busyBotId: kai.id });
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("removes a bot that is not answering and leaves the running turn alone", async () => {
    expect((await patch({ memberIds: [kai.id] })).status).toBe(200);
    expect(store.group(group.id)).toMatchObject({ memberIds: [kai.id], busyBotId: kai.id });
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("stops the answering bot's reply, then removes it", async () => {
    const rosterAtStop: string[][] = [];
    interruptTurn.mockImplementation(async () => { rosterAtStop.push([...store.group(group.id)!.memberIds]); });
    expect((await patch({ memberIds: [ray.id] })).status).toBe(200);
    expect(interruptTurn).toHaveBeenCalledWith(group.threadId);
    expect(rosterAtStop).toEqual([[kai.id, ray.id]]);
    expect(releaseInterruptedBot).toHaveBeenCalledWith(kai.id, group.threadId, false);
    expect(store.group(group.id)).toMatchObject({ memberIds: [ray.id], busyBotId: null });
  });

  it("still refuses a bulletin edit, in group words", async () => {
    const refused = await patch({ bulletin: "new rules" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/group/);
    expect(refused.body.error).not.toMatch(/channel/);
  });

  it("skips a queued responder removed before its turn, and the rest still answer", async () => {
    store.patchGroup(group.id, { memberIds: [kai.id, ray.id, zed.id], busyBotId: null });
    const groupQueues = new Map<string, Promise<void>>();
    const runGroupMemberTurn = vi.fn(async (_group: string, _thread: string, botId: string) => {
      if (botId === kai.id) store.patchGroup(group.id, { memberIds: [kai.id, zed.id] });
      return true;
    });
    const start = load("startGroupTurn", {
      store,
      peopleOnlyRoom: () => false,
      roomSetupPending: () => false,
      rootForStart: () => null,
      noteTalked: vi.fn(),
      mentionedBots: () => [],
      roomResponders: () => [kai, ray, zed].map((bot) => store.bot(bot.id)),
      resumePaneWakes: vi.fn(),
      taskPacketForWrite: () => null,
      seedTaskResumePacket: () => ({ instructionId: "i1" }),
      persistTaskPacket: vi.fn(),
      beginGroupTurnOperation: () => ({ cancelled: false, instructionId: "i1" }),
      finishGroupTurnOperation: vi.fn(),
      groupQueues,
      runGroupMemberTurn,
      roomTurnStillAssigned: load("roomTurnStillAssigned", { store }),
    });
    start(group.id, "everyone go");
    await groupQueues.get(group.id);
    expect(runGroupMemberTurn.mock.calls.map((call) => call[2])).toEqual([kai.id, zed.id]);
  });
});
