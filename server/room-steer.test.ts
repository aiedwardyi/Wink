import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "./contracts.ts";
import { createGroupRoutes } from "./group-routes.ts";
import { steerRoomSend } from "./room-steer.ts";
import { SendSequencer } from "./send-idempotency.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";

const bot = (id: string, name: string, busy: boolean) => ({ id, name, busy, threadId: `t-${id}` }) as BotRecord;

function setup(opts: { queueing?: boolean; steered?: boolean; settles?: boolean } = {}) {
  const bots = [bot("scout", "Scout", true), bot("pixel", "Pixel", false)];
  let group = { id: "g", threadId: "room-t", memberIds: ["scout", "pixel"], busyBotId: "scout", defaultResponder: { kind: "everyone" } } as GroupRecord;
  const rows: Message[] = [];
  const steer = vi.fn(async () => {
    if (opts.settles) group = { ...group, busyBotId: null };
    return opts.steered ?? true;
  });
  const deps = {
    store: {
      bot: (id: string) => bots.find((candidate) => candidate.id === id) ?? null,
      group: () => group,
      appendMessage: (_threadId: string, row: Omit<Message, "id" | "at">) => {
        const saved = { ...row, id: `m${rows.length}`, at: 1 } as Message;
        rows.push(saved);
        return saved;
      },
      patchMessage: () => null,
    },
    instanceForBot: () => ({ adapter: { capabilities: { queueing: opts.queueing ?? true }, steer } }) as unknown as ProviderInstance,
    userName: () => "Edward",
  };
  return { deps, group, rows, steer };
}

describe("steerRoomSend", () => {
  it("steers a plain line into the busy member's turn and records it as sent mid-turn", async () => {
    const { deps, group, rows, steer } = setup();
    const row = await steerRoomSend(deps, group, "also the tests", undefined, "send-1");
    expect(steer).toHaveBeenCalledWith("room-t", "also the tests", undefined, { fromUser: true });
    expect(row).toMatchObject({ role: "user", text: "also the tests", sendId: "send-1", steered: true });
    expect(rows).toHaveLength(1);
  });

  it("leaves the line to the room's next turn when it can't steer", async () => {
    for (const opts of [{ queueing: false }, { steered: false }]) {
      const { deps, group, rows } = setup(opts);
      expect(await steerRoomSend(deps, group, "later")).toBeNull();
      expect(rows).toEqual([]);
    }
  });

  it("keeps the room's routing for a line to another bot or everyone", async () => {
    for (const text of ["@Pixel take a look", "@Scout @Pixel both", "@everyone stop"]) {
      const { deps, group, steer } = setup();
      expect(await steerRoomSend(deps, group, text)).toBeNull();
      expect(steer).not.toHaveBeenCalled();
    }
  });

  it("refuses to record a steer the turn settled under", async () => {
    const { deps, group, rows } = setup({ settles: true });
    await expect(steerRoomSend(deps, group, "too late")).rejects.toMatchObject({ status: 409 });
    expect(rows).toEqual([]);
  });
});

describe("room send route", () => {
  it("hands the line back when a Stop lands during the steer", async () => {
    const { deps, group } = setup();
    const room = { ...group, dm: true };
    const startGroupTurn = vi.fn();
    const routes = createGroupRoutes({
      ...deps,
      store: { ...deps.store, group: () => room, messagesFor: () => [] },
      instanceForBot: () => ({ adapter: { capabilities: { queueing: true }, steer: async () => {
        room.busyBotId = null;
        await routes.interrupt(Readable.from([]) as unknown as IncomingMessage, { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse, ["", room.id] as RegExpMatchArray);
        return false;
      } } }),
      sendSequencer: new SendSequencer(),
      resolveReplyTarget: () => undefined,
      startGroupTurn,
      cancelGroupTurnOperations: vi.fn(),
      taskResumes: { forgetThread: vi.fn() },
      closeOpenApprovals: vi.fn(),
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const body = JSON.stringify({ text: "also the tests", sendId: "send-0123456789abcdef" });
    await routes.postMessage(Readable.from([body]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", room.id] as RegExpMatchArray);
    expect(startGroupTurn).not.toHaveBeenCalled();
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ cancelled: true });
  });
});
